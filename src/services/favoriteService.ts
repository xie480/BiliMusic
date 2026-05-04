import { biliApi } from './biliApi';
import { cache } from '../core/cache';
import { config } from '../config';
import { trimFolder, trimFavoriteVideo } from './transformers';
import type {
  FavoriteFolder,
  FavoriteVideo,
  PageResult,
  FolderSyncMeta,
} from '../types/domain';
import { storage } from '../core/storage';

export interface SyncProgressEvent {
  completedTasks: number;
  totalTasks: number;
  processedVideos: number;
  totalVideos: number;
}

export const favoriteService = {
  /**
   * 获取某 UID 的全部收藏夹
   * 带缓存，10 分钟内不会重复请求
   */
  async getFolders(uid: string, force = false, signal?: AbortSignal): Promise<FavoriteFolder[]> {
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
      true // 持久化
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
    signal?: AbortSignal
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
            .filter((m) => m.attr === 0)
            .map(trimFavoriteVideo),
          hasMore: data.has_more || false,
        };
      },
      true
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
   * 同步全局索引（增量同步）
   * 使用 FolderSyncMeta 追踪每个收藏夹的同步状态，仅拉取增量数据。
   * 新收藏夹或首次同步时全量拉取；后续仅拉取比游标 (latestBvid) 更新的视频。
   * 当检测到视频数量减少时，标记文件夹需要全量校准。
   * @param hiddenFolderIds 用户隐藏（不参与索引）的收藏夹 ID 列表
   */
  async syncGlobalIndex(uid: string, hiddenFolderIds: number[] = [], force = false, onProgress?: (event: SyncProgressEvent) => void, signal?: AbortSignal): Promise<void> {
    if (!uid) return;
    
    let folders = await this.getFolders(uid, force, signal);
    // 过滤掉用户隐藏的收藏夹，仅对可见收藏夹构建索引
    folders = folders.filter(f => !hiddenFolderIds.includes(f.id));
    
    // 加载同步元数据
    const syncMetaMap = storage.getSyncMetaMap();
    const now = Date.now();
    
    // 记录同步过程中发生错误的文件夹
    const failedFolders = new Set<number>();
    // 已成功同步的文件夹
    const syncedFolders = new Set<number>();
    
    let completedTasks = 0;
    let totalTasks = 0;
    let processedVideos = 0;
    let totalVideos = 0;
    
    const reportProgress = () => {
      if (onProgress) {
        onProgress({
          completedTasks: Math.min(completedTasks, Math.max(totalTasks, 1)),
          totalTasks: Math.max(totalTasks, 1),
          processedVideos: Math.min(processedVideos, Math.max(totalVideos, 1)),
          totalVideos: Math.max(totalVideos, 1),
        });
      }
    };
    
    // 带有指数退避的执行包装器
    const executeWithBackoff = async <T>(task: () => Promise<T>, maxRetries = 4): Promise<T> => {
      for (let i = 0; i <= maxRetries; i++) {
        try {
          return await task();
        } catch (e: any) {
          const isRateLimit = e?.name === 'RateLimitError' || e?.message?.includes('412') || e?.message?.includes('429');
          if (isRateLimit && i < maxRetries) {
            const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
            console.log(`Rate limited, waiting ${Math.round(delay)}ms before retry ${i + 1}...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          throw e;
        }
      }
      // 添加兜底的 throw 语句，解决 ts(2366) 报错
      throw new Error('Unreachable');
    };

    // Upsert 合并辅助函数：将视频加入局部 videoMap
    const upsertToMap = (
      videoMap: Map<string, FavoriteVideo>,
      folderId: number,
      video: FavoriteVideo
    ) => {
      if (!videoMap.has(video.bvid)) {
        videoMap.set(video.bvid, { ...video, folderIds: [folderId] });
      } else {
        const existing = videoMap.get(video.bvid)!;
        if (!existing.folderIds) existing.folderIds = [];
        if (!existing.folderIds.includes(folderId)) {
          existing.folderIds.push(folderId);
        }
        // 更新可能已变更的元信息
        existing.title = video.title;
        existing.cover = video.cover;
        existing.duration = video.duration;
        existing.pubtime = video.pubtime;
        existing.upper = video.upper;
        existing.attr = video.attr;
      }
    };
    
    // ── 判断每个文件夹的同步模式 ──
    interface FolderSyncPlan {
      folder: FavoriteFolder;
      mode: 'skip' | 'full' | 'incremental';
      cursorBvid: string | null;
    }
    
    const plans: FolderSyncPlan[] = [];
    let dirtyCount = 0;
    
    for (const folder of folders) {
      const meta = syncMetaMap[folder.id];
      
      if (force) {
        plans.push({ folder, mode: 'full', cursorBvid: null });
      } else if (!meta || meta.mediaCount === 0) {
        // 新收藏夹或无历史记录 → 全量同步
        plans.push({ folder, mode: 'full', cursorBvid: null });
      } else if (meta.needsFullSync) {
        // 曾被标记需要全量校准
        plans.push({ folder, mode: 'full', cursorBvid: null });
      } else if (folder.mediaCount === meta.mediaCount) {
        // 视频数量未变化，跳过
        plans.push({ folder, mode: 'skip', cursorBvid: null });
      } else if (folder.mediaCount > meta.mediaCount) {
        // 新增了视频 → 增量同步
        plans.push({ folder, mode: 'incremental', cursorBvid: meta.latestBvid || null });
      } else {
        // mediaCount 减少，有视频被删除 → 标记需要全量校准，本次跳过
        dirtyCount++;
        meta.needsFullSync = true;
        syncMetaMap[folder.id] = meta;
        console.log(`[favoriteService] 文件夹 ${folder.id} 的 mediaCount 从 ${meta.mediaCount} 减少到 ${folder.mediaCount}，标记为 needsFullSync`);
        plans.push({ folder, mode: 'skip', cursorBvid: null });
      }
    }
    
    // 持久化 needsFullSync 标记
    if (dirtyCount > 0) {
      storage.setSyncMetaMap(syncMetaMap);
    }
    
    // 估算总需拉取视频数（用于进度条）
    for (const p of plans) {
      if (p.mode === 'full') {
        totalVideos += p.folder.mediaCount;
      } else if (p.mode === 'incremental') {
        const meta = syncMetaMap[p.folder.id];
        if (meta) {
          totalVideos += p.folder.mediaCount - meta.mediaCount;
        }
      }
    }
    
    // 计算活跃文件夹数作为总任务数
    const activePlans = plans.filter(p => p.mode !== 'skip');
    totalTasks = activePlans.length;
    reportProgress();
    
    try {
      // ── 逐个文件夹串行同步，每个文件夹独立处理分页并立即落盘分片 ──
      for (const plan of activePlans) {
        if (signal?.aborted) break;
        
        const { folder, mode, cursorBvid } = plan;
        
        try {
          // 加载该文件夹的现有分片数据
          let existingVideos: FavoriteVideo[] = [];
          if (mode === 'incremental') {
            existingVideos = storage.getFolderIndex(folder.id);
          }
          // 全量模式从零开始
          
          const videoMap = new Map<string, FavoriteVideo>();
          for (const v of existingVideos) {
            videoMap.set(v.bvid, { ...v });
          }
          
          let page = 1;
          let hasMore = true;
          let folderDone = false;
          
          while (hasMore && !folderDone && !signal?.aborted) {
            try {
              const pageRes = await executeWithBackoff(() =>
                this.getVideos(folder.id, page, 20, force, signal)
              );
              
              // 增量模式：检查是否命中游标
              if (mode === 'incremental' && cursorBvid) {
                const cursorIndex = pageRes.list.findIndex(
                  (v: FavoriteVideo) => v.bvid === cursorBvid
                );
                
                if (cursorIndex === 0 && page === 1) {
                  // 第一页第一个视频就是游标 = 无新数据
                  folderDone = true;
                  break;
                }
                
                if (cursorIndex >= 0) {
                  // 命中游标 → 只取游标前的新视频
                  for (const v of pageRes.list.slice(0, cursorIndex)) {
                    upsertToMap(videoMap, folder.id, v);
                  }
                  folderDone = true;
                  processedVideos += cursorIndex;
                  reportProgress();
                  break;
                }
                // cursorIndex === -1，游标不在此页，继续翻页
              }
              
              // 处理本页所有视频
              for (const v of pageRes.list) {
                upsertToMap(videoMap, folder.id, v);
              }
              processedVideos += pageRes.list.length;
              reportProgress();
              
              hasMore = pageRes.hasMore;
              page++;
              
              // 每拉取一页后立即落盘分片（增量持久化，支持断点续传）
              storage.setFolderIndex(folder.id, Array.from(videoMap.values()));
              
            } catch (err: any) {
              failedFolders.add(folder.id);
              console.warn(
                `[favoriteService] 文件夹 ${folder.id} 第 ${page} 页拉取失败:`,
                err.message
              );
              if (err.name === 'RateLimitError' || err.message?.includes('412') || err.message?.includes('429')) {
                throw err; // 抛出限流异常，中断整个同步流程
              }
              break;
            }
          }
          
          if (!failedFolders.has(folder.id)) {
            // 最终落盘
            storage.setFolderIndex(folder.id, Array.from(videoMap.values()));
            syncedFolders.add(folder.id);
            
            // 更新同步元数据
            const finalVideos = storage.getFolderIndex(folder.id);
            syncMetaMap[folder.id] = {
              folderId: folder.id,
              lastSyncTime: now,
              latestBvid: finalVideos.length > 0 ? finalVideos[0].bvid : null,
              mediaCount: folder.mediaCount,
              needsFullSync: false,
              lastSyncedPage: page,
            };
            storage.updateSyncMeta(folder.id, syncMetaMap[folder.id]);
          }
        } catch (e: any) {
          failedFolders.add(folder.id);
          console.warn(
            `[favoriteService] 文件夹 ${folder.id} 同步失败:`,
            e.message
          );
          if (e.name === 'RateLimitError' || e.message?.includes('412') || e.message?.includes('429')) {
            throw e; // 抛出限流异常，中断整个同步流程
          }
        }
        
        completedTasks++;
        reportProgress();
      }
    } finally {
      // ── 全部文件夹处理完成后（或被限流中断），从分片重建全局索引缓存 ──
      storage.rebuildGlobalCache();
      
      console.log(
        `[favoriteService] 增量同步结束: 同步文件夹=${syncedFolders.size}, ` +
        `失败文件夹=${failedFolders.size}, 需校准=${dirtyCount}`
      );
    }
  },

  /**
   * 获取全局索引
   */
  getGlobalIndex(): FavoriteVideo[] {
    return storage.getGlobalIndexCached();
  },

  /**
   * 清理全局索引
   */
  clearGlobalIndex() {
    storage.clearAllIndexes();
  },
};
