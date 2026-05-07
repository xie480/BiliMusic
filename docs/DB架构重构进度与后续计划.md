# DB架构重构进度与后续计划

## 一、 当前重构进度盘点 (已完成部分)

经过对代码库的全面扫描与比对，当前 DB 架构重构已完成核心骨架的搭建，具体如下：

1. **底层数据模型与 Schema 重构 (100%)**：
   - `src/db/schema.ts` 已成功升级至 version 2，彻底废弃了旧的 JSON 关联存储，建立了 `playlist_meta`, `video_meta`, `sync_job` 三张核心表，索引拓扑结构符合方案预期。
   - 对应的 WatermelonDB Models (`PlaylistMeta.ts`, `VideoMeta.ts`, `SyncJob.ts`) 已创建并正确映射字段。
   - `src/db/database.ts` 已注册新模型，`src/db/migrations.ts` 已配置 V2 的建表迁移逻辑。
   - `src/db/migrate.ts` 已实现 V2 的数据清理与重置策略。

2. **核心数据访问层 Operations (90%)**：
   - `src/db/operations.ts` 已实现新架构所需的核心方法，包括：`upsertVideosBatch` (批量写入与软删除恢复), `upsertPlaylistMeta`, `updatePlaylistSyncProgress`, `markPlaylistSyncSuccess`, `createSyncJob`, `finishSyncJob`, `softDeleteMissingVideos`, `getAllValidVideos`, `getVideosByPlaylistId`, `getRandomVideosBatch`, `clearAllData`。

3. **业务逻辑层与 UI 适配 (80%)**：
   - `src/services/favoriteService.ts` 中的 `syncGlobalIndex` 已完全重写，成功接入了新的状态机、分页拉取、批量写入和软删除逻辑，具备了断点续传的基础。
   - `loadGlobalIndexCache` 已适配新架构，能将扁平化的 `video_meta` 重新聚合成带有 `folderIds` 数组的内存缓存，保障了 UI 层的平滑过渡。
   - 随机播放逻辑 (`getRandomVideos`) 已成功切换为基于 `random_weight` 的 O(1) 数据库查询。
   - `src/store/syncStore.ts` 已适配新的同步逻辑。
   - `src/screens/FoldersScreen.tsx` 和 `src/screens/VideosScreen.tsx` 的随机播放已接入新接口。

---

## 二、 遗留问题与半成品任务定位 (待办/故障部分)

当前工程处于“核心逻辑已通，但边缘模块断裂”的半成品状态，存在以下明确的故障点和技术债：

1. **编译与运行故障点 (Broken Code) - 优先级极高**：
   - **`src/screens/SyncDetailsScreen.tsx` 严重故障**：该文件仍在导入并使用已被删除的 `getAllSyncMetaMap` 方法（来自 `operations.ts`）和旧的 `FolderSyncMeta` 类型，导致应用在此处存在致命的编译/运行错误。

2. **功能缺失 (半成品) - 优先级高**：
   - **`favoriteService.ts` 中的 `deleteFolderIndex` 方法未实现**：目前处于注释 TODO 状态 (`// await removeFolderIdFromAllVideos(folderId);`)，缺少删除单个收藏夹及其关联视频的底层数据库操作。

3. **旧架构代码残留 (技术债) - 优先级中**：
   - `src/db/models/GlobalVideo.ts` 和 `src/db/models/SyncMeta.ts` 文件仍存在，未被物理删除。
   - `src/types/domain.ts` 中仍保留了旧的 `FolderSyncMeta` 类型定义。
   - `src/core/storage.ts` 中仍残留基于 MMKV 的旧同步状态管理方法 (`getSyncMetaMap`, `setSyncMetaMap`, `updateSyncMeta`, `deleteSyncMeta`, `clearSyncMeta`)，这些方法已失去实际作用，容易引起后续开发者的混淆。

---

## 三、 后续重构接力执行计划 (高容错性)

为了安全、稳定地完成剩余重构工作，制定以下接力执行计划：

**阶段一：清理技术债与废弃代码 (Clean Up)**
*   删除 `src/db/models/GlobalVideo.ts` 和 `src/db/models/SyncMeta.ts`。
*   从 `src/types/domain.ts` 中移除 `FolderSyncMeta` 接口。
*   从 `src/core/storage.ts` 中移除所有与 `syncMetaMap` 相关的读写方法。

**阶段二：补全底层数据库操作 (DB Operations)**
*   在 `src/db/operations.ts` 中新增 `getAllPlaylistMeta` 方法，用于获取所有收藏夹的同步元数据（供 SyncDetailsScreen 使用）。
*   在 `src/db/operations.ts` 中新增 `deletePlaylistAndVideos` 方法，用于彻底删除指定 `playlist_id` 的元数据和关联的视频记录。

**阶段三：修复业务逻辑与 UI 故障 (Fix & Refactor)**
*   完善 `src/services/favoriteService.ts` 中的 `deleteFolderIndex` 方法，调用新增的 `deletePlaylistAndVideos`。
*   重构 `src/screens/SyncDetailsScreen.tsx`：
    *   将数据源切换为 `getAllPlaylistMeta`。
    *   适配新的 `PlaylistMeta` 字段（如 `remoteVideoCount`, `localSyncedCount`, `syncStatus`, `needResync`）来展示同步状态。
    *   修复编译错误，确保页面正常渲染和交互。

**阶段四：全链路回归测试 (Verification)**
*   验证应用启动、全量同步、增量同步、断点续传是否正常。
*   验证 SyncDetailsScreen 的状态展示和删除功能是否正常。
*   验证随机播放和常规播放是否受影响。