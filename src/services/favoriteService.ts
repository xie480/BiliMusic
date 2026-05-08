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
  getPlaylistVideoCount,
  getVideosByPlaylistId,
} from '../db/operations';
import { database, videoMetaCollection } from '../db/database';
import { Q } from '@nozbe/watermelondb';
import { Mutex } from '../utils/mutex';
import { AuthRequiredError } from '../core/errors';
import LoggerService from './LoggerService';
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
    favTime: v.favTime || 0,
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

/**
 * 单收藏夹增量刷新 —— 仅拉取新增视频数据，不触发全量重新加载。
 *
 * === 数据流向 ===
 * 1. 从本地数据库获取当前收藏夹已有视频的 BVID 集合
 * 2. 从 B 站 API 逐页拉取（order=mtime 收藏时间倒序，最新视频排在最前）
 * 3. 遍历远端数据，遇到首个已存在于本地的 BVID 时停止（后续全部为旧数据）
 * 4. 将纯新增的视频批量写入 WatermelonDB（upsertVideosBatch）
 * 5. 将新增视频直接追加合并到 globalIndexCache（内存缓存），不触发全量 DB 重读
 * 6. 返回新增视频列表供 UI 层直接消费
 *
 * === 增量判断原理 ===
 * B 站收藏夹资源列表接口支持 order=mtime 参数，返回按收藏时间倒序排列的数据。
 * 因此最新收藏的视频必定排在列表最前面。利用这一特性，只需逐页读取直到遇到本地
 * 已存在的视频，即可断定后续再无增量数据，从而以最少 API 调用量完成增量检测。
 *
 * @param mediaId  收藏夹 ID
 * @param signal   可选的 AbortSignal，用于取消进行中的请求
 * @returns        新增视频列表（FavoriteVideo[]），无新增时返回空数组
 */
async function syncSingleFolder(
  mediaId: number,
  signal?: AbortSignal,
): Promise<FavoriteVideo[]> {
  const playlistId = mediaId.toString();

  // Step 1: 读取本地已有视频的 BVID 集合（仅限该收藏夹，含未删除记录）
  const existingLocalRecords = await getVideosByPlaylistId(playlistId);
  const existingBvids = new Set(
    existingLocalRecords.map((v: VideoMeta) => v.videoId),
  );

  const newVideos: FavoriteVideo[] = [];
  let page = 1;
  let hasMore = true;
  let reachedExisting = false;

  // Step 2: 逐页拉取远端数据，force=true 绕过内存缓存确保获取最新内容
  while (hasMore && !reachedExisting && !signal?.aborted) {
    const pageRes = await favoriteService.getVideos(mediaId, page, 20, true, signal);
    if (pageRes.list.length === 0) break;

    for (const video of pageRes.list) {
      if (existingBvids.has(video.bvid)) {
        // 由 mtime 倒序可知：一旦遇到已存在的视频，后续全为旧数据，终止拉取
        reachedExisting = true;
        break;
      }
      // 确保 folderIds 携带当前收藏夹 ID（trimFavoriteVideo 不填充此字段）
      video.folderIds = video.folderIds
        ? [...new Set([...video.folderIds, mediaId])]
        : [mediaId];
      newVideos.push(video);
      existingBvids.add(video.bvid); // 同批次内去重
    }

    hasMore = pageRes.hasMore;
    page++;

    // 请求间隔抖动，防止触发 B 站接口限流
    if (hasMore && !reachedExisting) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    }
  }

  // 无新增数据，提前返回空数组
  if (newVideos.length === 0) return [];

  // Step 3: 批量写入 WatermelonDB（upsertVideosBatch 内部区分 create / update）
  await upsertVideosBatch(playlistId, newVideos);

  // Step 4: 直接追加合并至全局索引内存缓存 —— 绝不触发全量 DB 重读
  const cacheBvids = new Set(globalIndexCache.map(v => v.bvid));
  for (const video of newVideos) {
    if (!cacheBvids.has(video.bvid)) {
      // 纯新增视频，追加到缓存尾部
      globalIndexCache.push(video);
    } else {
      // 该 BVID 已在缓存中（可能来自其他收藏夹），仅补充 folderIds
      const cached = globalIndexCache.find(v => v.bvid === video.bvid);
      if (cached && video.folderIds) {
        cached.folderIds = [
          ...new Set([...(cached.folderIds || []), ...video.folderIds]),
        ];
      }
    }
  }

  return newVideos;
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
      let baseProcessedVideos = 0;
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
          baseProcessedVideos += folder.mediaCount;
          processedVideos = baseProcessedVideos;
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
        // 断点续传：如果不是强制全量，且有游标，则从游标处继续
        if (!force && localMeta.syncCursor && localMeta.syncCursor.startsWith('page_')) {
          const cursorPage = parseInt(localMeta.syncCursor.replace('page_', ''), 10);
          if (!isNaN(cursorPage) && cursorPage > 0) {
            page = cursorPage + 1; // 从下一页开始
          }
        }

        let hasMore = true;
        let isIncrementalDone = false;
        const remoteVideoIds: string[] = [];

        try {
          while (hasMore && !isIncrementalDone && !signal?.aborted) {
            // 抖动防限流
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 2000) + 1000));
            
            const pageRes = await this.getVideos(folder.id, page, 20, force, signal);
            
            if (pageRes.list.length === 0) {
              break;
            }

            const videosToUpsert: FavoriteVideo[] = [];
            const currentBvids = pageRes.list.map(v => v.bvid);

            for (const video of pageRes.list) {
              remoteVideoIds.push(video.bvid);
              videosToUpsert.push(video);
            }

            // 检查增量同步是否完成：如果当前页的视频在本地都已经存在，说明增量部分已经拉取完毕
            if (!force && localMeta.localSyncedCount > 0 && page === 1) {
               // 仅在第一页检查，如果第一页有部分视频已存在，说明是增量
               // 为了更准确，我们查询数据库看这些 bvid 是否都存在
               const existingCount = await videoMetaCollection.query(
                 Q.where('playlist_id', playlistId),
                 Q.where('video_id', Q.oneOf(currentBvids))
               ).fetchCount();
               
               // 如果当前页的所有视频都在本地存在，说明没有新视频，可以提前结束
               if (existingCount === currentBvids.length && currentBvids.length > 0) {
                 isIncrementalDone = true;
               }
            } else if (!force && localMeta.localSyncedCount > 0 && page > 1) {
               // 如果不是第一页，且遇到了已存在的视频，也可以认为增量结束
               const existingCount = await videoMetaCollection.query(
                 Q.where('playlist_id', playlistId),
                 Q.where('video_id', Q.oneOf(currentBvids))
               ).fetchCount();
               if (existingCount > 0) {
                 isIncrementalDone = true;
               }
            }

            // 批量写入
            await upsertVideosBatch(playlistId, videosToUpsert);
            
            // 获取当前收藏夹的绝对有效视频数量
            const absoluteSyncedCount = await getPlaylistVideoCount(playlistId);
            
            // 更新游标和进度（使用绝对数量）
            await updatePlaylistSyncProgress(playlistId, `page_${page}`, absoluteSyncedCount);
            
            // 更新总进度
            processedVideos = baseProcessedVideos + absoluteSyncedCount;
            reportProgress();

            hasMore = pageRes.hasMore || pageRes.rawCount === 20;
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
          LoggerService.warn('favoriteService', 'syncPlaylist', `文件夹 ${folder.id} 同步异常:`, err.message);
          await finishSyncJob(jobId, 'failed', err.message);
          await upsertPlaylistMeta({ playlistId, remoteVideoCount: folder.mediaCount, syncStatus: 'failed' });
          if (err instanceof AuthRequiredError) {
            throw err;
          }
        }

        completedTasks++;
        baseProcessedVideos += folder.mediaCount;
        processedVideos = baseProcessedVideos;
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

  /**
   * 单收藏夹增量刷新：检测收藏夹内新增视频并合并到全局索引。
   * 详情见上方 syncSingleFolder 函数定义及注释。
   */
  syncSingleFolder,
};
