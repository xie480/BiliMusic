# DB架构重构工程方案

基于 `docs/重构DB架构.md` 的指导原则，针对当前 React Native + WatermelonDB 环境下的全量索引存储架构，制定以下详尽的重构实施工程方案。

## 1. 新旧架构差异分析与核心重构目标

### 1.1 旧架构痛点分析 (`src/db/schema.ts`)
*   **反模式的 JSON 关联存储**：`global_videos` 表中使用 `folder_ids` (JSON 字符串) 存储关联的收藏夹 ID。这导致无法利用 SQLite 索引进行高效的收藏夹内视频查询，每次查询都需要全表扫描或在内存中反序列化过滤。
*   **并发更新冲突与性能损耗**：在多收藏夹并发同步时，对同一个视频的 `folder_ids` 进行读-改-写（Merge）操作极易产生竞态条件。同时，频繁的 JSON 序列化/反序列化消耗大量 CPU 资源。
*   **缺乏断点续传机制**：`sync_meta` 仅记录了 `last_synced_page`，在发生网络异常或应用崩溃时，难以精确恢复同步状态，往往需要重新全量同步。
*   **硬删除引发的 IO 瓶颈**：`removeFolderIdFromAllVideos` 涉及大量的读写和硬删除操作。在 SQLite 中，大规模硬删除会导致频繁的 B-Tree 重平衡，引发严重的 IO 瓶颈、锁表以及 RN 端的 UI 掉帧。
*   **随机播放性能极差**：当前架构缺乏对随机播放的底层支持，依赖内存打乱或 `ORDER BY RANDOM()`，在数据量达到万级别时会导致 SQLite 性能雪崩。

### 1.2 新架构核心目标
*   **彻底消除 JSON 关联查询**：采用扁平化设计，将视频与收藏夹的关系明确化（每个收藏夹下的视频作为独立记录或通过关联表），充分利用 SQLite 复合索引。
*   **实现高可靠的断点续传**：引入 `sync_job` 任务表和精确的 `sync_cursor` 游标机制，确保任何异常中断都能无缝恢复。
*   **软删除与增量同步**：采用 `is_deleted` 标记替代硬删除，结合远端版本号（`remote_revision`）实现高效的增量比对，大幅降低 SQLite IO。
*   **极致的随机播放性能**：引入预计算的 `random_weight` 字段，将 O(N) 的随机排序降维为 O(1) 的索引查询。
*   **严格控制 SQLite IO**：强制实施分页拉取与批量写入（Batch Write），单批次控制在 20-50 条，彻底杜绝锁表和 Android ANR。

---

## 2. 全新全量索引数据模型与底层存储拓扑

### 2.1 数据模型设计 (WatermelonDB Schema)
完全对齐文档规范，设计三张核心表：

1.  **`playlist_meta` (收藏夹元数据表)**：
    *   核心字段：`playlist_id`, `remote_video_count`, `local_synced_count`, `sync_cursor`, `remote_revision`, `sync_status`, `need_resync`。
    *   作用：管理同步状态机、游标和统计信息，作为增量同步的基准。
2.  **`video_meta` (视频元数据表)**：
    *   核心字段：`video_id`, `playlist_id`, `random_weight`, `is_cached`, `is_deleted`, `extra_json`。
    *   作用：核心业务表。注意：为了极致的查询性能和避免复杂的关联，同一个视频在不同收藏夹中将拥有独立的记录（以 `video_id` + `playlist_id` 为逻辑主键）。
3.  **`sync_job` (同步任务表)**：
    *   核心字段：`job_id`, `playlist_id`, `status`, `cursor_start`, `cursor_end`, `synced_count`。
    *   作用：记录同步生命周期，用于故障排查、进度展示和断点恢复。

### 2.2 索引拓扑结构
`video_meta` 表必须建立以下关键索引以保障性能：
*   `idx_video_id`: 用于去重和快速更新。
*   `idx_playlist_id`: 用于收藏夹列表极速加载。
*   `idx_video_deleted`: 用于全局过滤已删除视频。
*   `idx_publish_time`: 用于按时间排序。
*   `idx_random_weight`: 用于 O(1) 复杂度的随机播放 (`WHERE random_weight > x LIMIT 1`)。

---

## 3. 核心数据访问层及索引构建模块重构实现

### 3.1 Schema & Models 重构
*   **废弃**：`src/db/models/GlobalVideo.ts`, `src/db/models/SyncMeta.ts`。
*   **新增**：`PlaylistMeta.ts`, `VideoMeta.ts`, `SyncJob.ts`。
*   **更新**：`src/db/schema.ts`，应用新的 `tableSchema`。

### 3.2 核心同步流程 (Sync State Machine)
实现严格的状态流转：`idle` -> `checking` -> `syncing` -> `success` / `failed` / `cancelled`。

**核心重构代码逻辑 (Batch Upsert)**：
WatermelonDB 没有原生 Upsert，需手动实现高效的批量处理：
```typescript
async function upsertVideosBatch(playlistId: string, videos: any[]) {
  const collection = database.collections.get('video_meta');
  const videoIds = videos.map(v => v.id);
  
  // 1. 批量查出当前批次在本地已存在的记录
  const existingRecords = await collection.query(
    Q.where('playlist_id', playlistId),
    Q.where('video_id', Q.oneOf(videoIds))
  ).fetch();
  
  const existingMap = new Map(existingRecords.map(r => [r.videoId, r]));
  const batchOperations = [];

  // 2. 区分 create 和 update 操作
  for (const video of videos) {
    const existing = existingMap.get(video.id);
    if (existing) {
      batchOperations.push(existing.prepareUpdate(v => {
        v.title = video.title;
        v.cover = video.cover;
        v.isDeleted = false; // 恢复软删除
        v.updatedAt = Date.now();
      }));
    } else {
      batchOperations.push(collection.prepareCreate(v => {
        v.videoId = video.id;
        v.playlistId = playlistId;
        v.title = video.title;
        v.randomWeight = Math.random(); // 预生成随机权重
        v.isDeleted = false;
        v.syncedAt = Date.now();
      }));
    }
  }
  
  // 3. 统一执行 database.batch()
  await database.write(async writer => {
    await writer.batch(...batchOperations);
  });
}
```

### 3.3 软删除与差集计算
同步完成后，比对远端视频集合与本地视频集合，对本地多出的记录执行软删除：
```typescript
batchOperations.push(record.prepareUpdate(v => {
  v.isDeleted = true;
}));
```

---

## 4. 数据强一致性及业务平滑过渡的无缝迁移策略

由于底层数据结构发生了根本性变化（从 JSON 数组关联变为扁平化的一对多关系），必须确保用户数据的平滑过渡。

### 4.1 迁移方案 (Migration Strategy)
1.  **Schema 版本升级**：在 `src/db/schema.ts` 中将 `version` 升级（例如从 1 升至 2）。
2.  **数据迁移脚本 (Migrations)**：
    在 `src/db/migrate.ts` 中编写版本迁移逻辑：
    *   创建新表 `playlist_meta`, `video_meta`, `sync_job`。
    *   **数据转换**：遍历旧表 `global_videos`，解析 `folder_ids` JSON 数组。对于数组中的每一个 `folder_id`，在 `video_meta` 中生成一条对应记录。
    *   **元数据转换**：将 `sync_meta` 的数据映射并插入到 `playlist_meta` 中。
    *   **清理**：迁移完成后，安全地 drop 掉旧表 `global_videos` 和 `sync_meta`。
3.  **容错机制**：如果迁移过程中发生崩溃，下次启动时应能识别未完成的迁移并重试，或者在极端情况下清除本地缓存触发全量重新同步（因为数据源在 B 站云端，本地数据本质上是缓存，可重建）。

---

## 5. 性能压测基准与高可用性保障措施

### 5.1 性能压测基准 (Benchmarks)
*   **同步吞吐量**：单次批量写入 50 条记录，耗时需控制在 **50ms** 以内。
*   **查询延迟**：在 10 万级别视频数据下，按 `playlist_id` 查询并分页（20条），响应时间 **< 10ms**。
*   **随机播放延迟**：基于 `random_weight` 索引，随机获取下一首歌曲耗时 **< 5ms**。

### 5.2 高可用保障
*   **防锁表机制**：所有写入操作必须通过 `TaskQueue` 或 `Mutex` 串行化，并严格限制单次 `database.batch` 的大小（推荐 20~50，绝对不超过 100）。
*   **崩溃恢复 (Crash Recovery)**：每次启动 APP 时，检查 `sync_job` 中状态为 `running` 的任务，自动将其标记为 `failed`。下次同步时，直接读取 `playlist_meta.sync_cursor` 继续断点续传。
*   **JS Bridge 保护**：避免一次性将大量数据（如整个收藏夹的几千个视频）从 SQLite 传递到 JS 侧，强制在 UI 层和数据层都使用分页加载。
