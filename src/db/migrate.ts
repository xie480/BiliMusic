import { storage as mmkvStorage } from '../core/storage';
import { batchUpsertGlobalVideos, updateSyncMeta } from './operations';
import type { FolderSyncMeta, FavoriteVideo } from '../types/domain';

/**
 * 将 MMKV 中已有的索引及同步元数据无损迁移至 WatermelonDB。
 * 迁移完成后可选择清除 MMKV 旧数据（默认不清除，保留兜底）。
 */
export async function migrateFromMMKV(clearOldData = false): Promise<{
  syncedFolders: number;
  migratedVideos: number;
}> {
  let migratedVideos = 0;
  let syncedFolders = 0;

  // 1. 迁移 FolderSyncMeta
  const oldSyncMetaMap = mmkvStorage.getSyncMetaMap();
  for (const folderIdStr of Object.keys(oldSyncMetaMap)) {
    const folderId = parseInt(folderIdStr, 10);
    const meta = oldSyncMetaMap[folderId];
    if (meta && !isNaN(folderId)) {
      await updateSyncMeta(meta);
      syncedFolders++;
    }
  }

  // 2. 迁移 folderIndex 分片（GlobalVideos）
  const indexedFolderIds = mmkvStorage.getAllIndexedFolderIds();
  for (const folderId of indexedFolderIds) {
    const videos: FavoriteVideo[] = mmkvStorage.getFolderIndex(folderId);
    if (videos.length > 0) {
      await batchUpsertGlobalVideos(videos);
      migratedVideos += videos.length;
    }
  }

  // 3. 可选清理 MMKV 旧数据
  if (clearOldData) {
    mmkvStorage.clearAllIndexes();
    mmkvStorage.clearSyncMeta();
  }

  console.log(
    `[migrate] MMKV → WatermelonDB 迁移完成：` +
    `同步元数据 ${syncedFolders} 个，视频 ${migratedVideos} 条`
  );

  return { syncedFolders, migratedVideos };
}
