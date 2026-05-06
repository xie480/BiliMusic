# WatermelonDB 迁移测试策略与验证方案

在将 BiliMusic 的持久化层从 MMKV 迁移到 WatermelonDB 后，为了确保数据完整性、同步逻辑的正确性以及应用的稳定性，需要进行全面的测试。以下是详细的测试策略与验证方案。

## 1. 单元测试 (Unit Testing)

### 1.1 数据库操作层 (`src/db/operations.ts`)
- **`upsertGlobalVideo`**:
  - 验证插入新视频时，字段映射是否正确。
  - 验证更新已存在视频时，`folderIds` 是否能正确合并去重。
  - 验证更新时，其他元数据（如 `title`, `cover`）是否被正确覆盖。
- **`batchUpsertGlobalVideos`**:
  - 验证批量插入/更新的事务性，确保部分失败时不会产生脏数据。
- **`getGlobalIndex` / `getVideosByFolderId`**:
  - 验证查询结果的正确性，特别是 JSON 字段（`folderIds`, `parts`）的解析。
- **`updateSyncMeta` / `getSyncMeta`**:
  - 验证同步元数据的读写，特别是 `needsFullSync` 标记的持久化。
- **`removeFolderIdFromAllVideos`**:
  - 验证移除特定 `folderId` 后，若视频的 `folderIds` 为空，该记录是否被正确标记为删除。

### 1.2 互斥锁 (`src/utils/mutex.ts`)
- 验证并发调用 `acquire()` 时，后续调用是否被正确阻塞。
- 验证 `release()` 后，等待队列中的任务是否按顺序被唤醒。

### 1.3 同步逻辑 (`src/services/favoriteService.ts`)
- **全量同步**:
  - 模拟新收藏夹或 `needsFullSync=true` 的情况，验证是否调用了 `removeFolderIdFromAllVideos` 并全量拉取数据。
- **增量同步**:
  - 模拟 `mediaCount` 增加的情况，验证是否正确使用 `cursorBvid` 截断数据，并仅插入新视频。
- **异常处理**:
  - 模拟网络错误或限流（412/429），验证指数退避重试机制是否生效。
  - 验证重试失败后，该文件夹是否被加入 `failedFolders`，且不影响其他文件夹的同步。

## 2. 集成测试 (Integration Testing)

### 2.1 数据迁移模块 (`src/db/migrate.ts`)
- **前置条件**: 在 MMKV 中预置旧版格式的全局索引和同步元数据。
- **执行迁移**: 调用 `migrateFromMMKVToWatermelonDB()`。
- **验证点**:
  - 验证 WatermelonDB 中的 `global_videos` 表数据量与 MMKV 一致。
  - 验证 `folderIds` 映射正确。
  - 验证 `sync_meta` 表数据正确。
  - 验证迁移完成后，MMKV 中的旧数据是否被正确清理（或标记为已迁移）。

### 2.2 应用启动流程 (`src/App.tsx`)
- 验证应用启动时，`uid` 变化或本地索引为空时，是否正确触发了 `clearGlobalIndex`。
- 验证启动时是否正确调用了 `loadGlobalIndexCache()` 将数据加载到内存。

## 3. 端到端测试 (E2E Testing) / 手动验证

### 3.1 首次同步
1. 登录一个包含多个收藏夹的账号。
2. 触发全局同步。
3. **预期结果**: 所有可见收藏夹的视频被拉取，进度条显示正确，同步完成后 UI 能正常展示所有视频。

### 3.2 增量同步
1. 在 B 站客户端向某个已同步的收藏夹添加 1-2 个新视频。
2. 在 BiliMusic 中再次触发同步。
3. **预期结果**: 同步速度极快（仅拉取第一页），新视频出现在列表中。

### 3.3 收藏夹视频减少 (触发全量校准)
1. 在 B 站客户端从某个收藏夹删除一个视频。
2. 在 BiliMusic 中触发同步。
3. **预期结果**: 该文件夹的 `mediaCount` 减少，被标记为 `needsFullSync`，本次跳过。
4. 再次触发同步。
5. **预期结果**: 该文件夹执行全量同步，被删除的视频从本地索引中消失。

### 3.4 隐藏收藏夹变更
1. 在设置中修改“可见收藏夹”的配置（隐藏或取消隐藏某个文件夹）。
2. **预期结果**: 触发全局索引重建（清空并重新加载），UI 列表更新。

### 3.5 离线模式
1. 断开网络连接。
2. 验证是否能正常浏览已同步的全局索引和收藏夹列表。
3. 验证是否能正常播放已缓存的音频。

## 4. 性能与压力测试

- **大数据量测试**: 使用包含 5000+ 视频的账号进行同步，观察内存占用和 UI 卡顿情况。WatermelonDB 的懒加载特性应能显著改善旧版 MMKV 全量 JSON 序列化带来的性能瓶颈。
- **并发触发**: 尝试在同步过程中多次点击“同步”按钮，验证互斥锁 (`Mutex`) 是否有效防止了并发冲突。

## 5. 监控与日志

- 确保在生产环境中捕获 WatermelonDB 的数据库异常。
- 监控同步过程中的限流日志（Rate limited），评估指数退避策略的实际效果。
