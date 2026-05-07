import { biliApi } from './biliApi';
import { cache } from '../core/cache';
import { config } from '../config';
import { trimFolder, trimFavoriteVideo } from './transformers';
import type {
  FavoriteFolder,
  FavoriteVideo,
  PageResult,
} from '../types/domain';
import {
  upsertPlaylistMeta,
  getPlaylistMeta,
  createSyncJob,
  finishSyncJob,
  upsertVideosBatch,
  updatePlaylistSyncProgress,
  markPlaylistSyncSuccess,
  softDeleteMissingVideos,
  getAllValidVideos,
  getRandomVideosBatch,
  clearAllData,
  deletePlaylistAndVideos,
} from '../db/operations';
import { Mutex } from '../utils/mutex';
import { AuthRequiredError } from '../core/errors';
import type { VideoMeta } from '../db/models/VideoMeta';

export interface SyncProgressEvent {
  completedTasks: number;
  totalTasks: number;
  processedVideos: number;
  totalVideos: number;
}

// 内存缓存，用于同步读取全局索引（UI 层渲染时需同步获取）
let globalIndexCache: FavoriteVideo[] = [];

// 互斥锁，防止同步任务并发执行
const syncMutex = new Mutex();

function mapVideoMetaToFavoriteVideo(v: VideoMeta): FavoriteVideo {
  return {
    bvid: v.videoId,
    title: v.title,
    cover: v.cover || '',
    duration: v.duration || 0,
    page: 1,
    pubtime: v.publishTime || 0,
    upper: { mid: 0, name: v.author || '' },
    attr: 0,
    folderIds: [parseInt(v.playlistId, 10)],
    parts: v.extraJson ? JSON.parse(v.extraJson) : undefined,
  };
}

/**
 * 从 WatermelonDB 加载全局索引到内存缓存。
 * 应在应用启动时（uid useEffect）和同步完成后调用。
 */
export async function loadGlobalIndexCache(): Promise<void> {
  const validVideos = await getAllValidVideos();
  // 去重，因为同一个视频可能在多个收藏夹中
  const uniqueVideosMap = new Map<string, FavoriteVideo>();
  for (const v of validVideos) {
    if (!uniqueVideosMap.has(v.videoId)) {
      uniqueVideosMap.set(v.videoId, mapVideoMetaToFavoriteVideo(v));
    } else {
      // 合并 folderIds
      const existing = uniqueVideosMap.get(v.videoId)!;
      const folderId = parseInt(v.playlistId, 10);
      if (!existing.folderIds!.includes(folderId)) {
        existing.folderIds!.push(folderId);
      }
    }
  }
  globalIndexCache = Array.from(uniqueVideosMap.values());
}

export const favoriteService = {
  /**
   * 获取某 UID 的全部收藏夹
   * 带缓存，10 分钟内不会重复请求
   */
  async getFolders(
    uid: string,
    force = false,
    signal?: AbortSignal,
  ): Promise<FavoriteFolder[]> {
    if (!uid || !uid.trim()) {
      throw new Error('UID 不能为空');
    }
    const key = `folders:${uid}`;
    if (force) cache.delete(key);
    return cache.getOrSet(
      key,
      config.cacheTTL.folders,
      async () => {
        const data = await biliApi.getFavoriteFolders(uid, signal);
        return (data.list || []).map(trimFolder);
      },
      true, // 持久化
    );
  },

  /**
   * 获取收藏夹内视频（分页）
   * 自动过滤已失效条目
   */
  async getVideos(
    mediaId: number,
    pn = 1,
    ps = 20,
    force = false,
    signal?: AbortSignal,
  ): Promise<PageResult<FavoriteVideo>> {
    if (!mediaId) {
      throw new Error('收藏夹 ID 不能为空');
    }
    const key = `videos:${mediaId}:${pn}:${ps}`;
    if (force) cache.delete(key);
    return cache.getOrSet(
      key,
      config.cacheTTL.folderVideos,
      async () => {
        const data = await biliApi.getFavoriteVideos(mediaId, pn, ps, signal);
        return {
          list: (data.medias || [])
            .filter(m => m.attr === 0)
            .map(trimFavoriteVideo),
          hasMore: data.has_more || false,
          rawCount: (data.medias || []).length,
        };
      },
      true,
    );
  },

  /** 失效某收藏夹的所有缓存（如用户主动刷新） */
  invalidateFolder(mediaId: number) {
    cache.deletePrefix(`videos:${mediaId}`);
  },

  /** 失效某用户的收藏夹列表缓存 */
  invalidateFolderList(uid: string) {
    cache.delete(`folders:${uid}`);
  },

  /**
   * 同步全局索引（增量同步），使用 WatermelonDB 持久化。
   * 基于全新的 DB 架构，支持断点续传和增量同步。
   */
  async syncGlobalIndex(
    uid: string,
    hiddenFolderIds: number[] = [],
    force = false,
    onProgress?: (event: SyncProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!uid) return;

    await syncMutex.acquire();
    try {
      let folders = await this.getFolders(uid, force, signal);
      folders = folders.filter(f => !hiddenFolderIds.includes(f.id));

      let completedTasks = 0;
      let totalTasks = folders.length;
      let processedVideos = 0;
      let totalVideos = folders.reduce((sum, f) => sum + f.mediaCount, 0);

      const reportProgress = () => {
        if (onProgress) {
          onProgress({
            completedTasks,
            totalTasks,
            processedVideos,
            totalVideos,
          });
        }
      };

      reportProgress();

      for (const folder of folders) {
        if (signal?.aborted) break;

        const playlistId = folder.id.toString();
        let localMeta = await getPlaylistMeta(playlistId);

        // 1. 判断是否需要同步
        let needSync = false;
        if (force || !localMeta) {
          needSync = true;
        } else if (
          localMeta.localSyncedCount < folder.mediaCount ||
          localMeta.needResync ||
          localMeta.syncStatus === 'failed' ||
          localMeta.syncStatus === 'running' // 上次崩溃
        ) {
          needSync = true;
        }

        if (!needSync) {
          completedTasks++;
          processedVideos += folder.mediaCount;
          reportProgress();
          continue;
        }

        // 2. 初始化或更新 Meta
        await upsertPlaylistMeta({
          playlistId,
          title: folder.title,
          remoteVideoCount: folder.mediaCount,
          syncStatus: 'syncing',
          needResync: force ? true : (localMeta?.needResync || false),
        });

        localMeta = await getPlaylistMeta(playlistId);
        if (!localMeta) continue;

        // 3. 创建同步任务
        const jobId = await createSyncJob(playlistId, null);

        let page = 1;
        // 如果不是强制全量，且有游标（这里用已同步数量推算页码作为简单的游标实现，或者直接从头查直到遇到已存在的）
        // 为了简化并保证一致性，我们采用分页拉取，遇到已存在的视频（增量）则停止
        let hasMore = true;
        let isIncrementalDone = false;
        let currentSyncedCount = 0;
        const remoteVideoIds: string[] = [];

        try {
          while (hasMore && !isIncrementalDone && !signal?.aborted) {
            // 抖动防限流
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000) + 1000));
            
            const pageRes = await this.getVideos(folder.id, page, 50, force, signal);
            
            if (pageRes.list.length === 0) {
              break;
            }

            const videosToUpsert: FavoriteVideo[] = [];

            for (const video of pageRes.list) {
              remoteVideoIds.push(video.bvid);
              videosToUpsert.push(video);
            }

            // 批量写入
            await upsertVideosBatch(playlistId, videosToUpsert);
            
            currentSyncedCount += videosToUpsert.length;
            processedVideos += videosToUpsert.length;
            
            // 更新游标和进度
            await updatePlaylistSyncProgress(playlistId, `page_${page}`, videosToUpsert.length);
            reportProgress();

            // 如果是增量同步，且发现本页的视频在本地都已经存在，可以考虑提前结束
            // 但为了处理用户在 B 站删除了视频的情况，最好还是全量拉取 ID 列表进行差集比对
            // 这里为了性能，如果只是新增，我们拉取到足够数量即可。
            // 严格模式下，为了支持软删除，我们需要拉取所有远端 ID。
            // 考虑到 B 站 API 限制，如果收藏夹很大，全量拉取 ID 也很慢。
            // 妥协方案：如果 force=false 且只是新增了几个视频，我们拉取到旧视频就停止，放弃软删除检测。
            // 如果需要软删除检测，必须 force=true。
            if (!force && localMeta.localSyncedCount > 0) {
               // 检查是否遇到了上次同步的视频
               // 简化逻辑：如果当前拉取的总数已经覆盖了差值，且多拉了一页，就停止
               const diff = folder.mediaCount - (localMeta.localSyncedCount || 0);
               if (diff > 0 && currentSyncedCount >= diff + 50) {
                   isIncrementalDone = true;
               } else if (diff <= 0) {
                   isIncrementalDone = true;
               }
            }

            hasMore = pageRes.hasMore || pageRes.rawCount === 50;
            page++;
          }

          if (!signal?.aborted) {
            // 4. 软删除（仅在全量拉取时执行）
            if (force || (!isIncrementalDone && !hasMore)) {
               await softDeleteMissingVideos(playlistId, remoteVideoIds);
            }

            await finishSyncJob(jobId, 'success');
            await markPlaylistSyncSuccess(playlistId);
          } else {
            await finishSyncJob(jobId, 'cancelled');
            await upsertPlaylistMeta({ playlistId, remoteVideoCount: folder.mediaCount, syncStatus: 'idle' });
          }

        } catch (err: any) {
          console.warn(`[favoriteService] 文件夹 ${folder.id} 同步异常:`, err.message);
          await finishSyncJob(jobId, 'failed', err.message);
          await upsertPlaylistMeta({ playlistId, remoteVideoCount: folder.mediaCount, syncStatus: 'failed' });
          if (err instanceof AuthRequiredError) {
            throw err;
          }
        }

        completedTasks++;
        reportProgress();
      }

    } finally {
      syncMutex.release();
      await loadGlobalIndexCache();
    }
  },

  /**
   * 获取全局索引（同步返回）
   */
  getGlobalIndex(): FavoriteVideo[] {
    return globalIndexCache;
  },

  /**
   * 清理全局索引
   */
  async clearGlobalIndex() {
    await clearAllData();
    globalIndexCache = [];
  },

  /**
   * 删除指定收藏夹的索引数据
   */
  async deleteFolderIndex(folderId: number) {
    const playlistId = folderId.toString();
    await deletePlaylistAndVideos(playlistId);
    await loadGlobalIndexCache();
  },

  /**
   * 随机获取一批视频（O(1) 复杂度）
   */
  async getRandomVideos(playlistId?: string, limit: number = 50): Promise<FavoriteVideo[]> {
    const records = await getRandomVideosBatch(playlistId, limit);
    return records.map(mapVideoMetaToFavoriteVideo);
  },
};
