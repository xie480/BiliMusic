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
import { TaskQueue } from '../utils/taskQueue';

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
    
    // 加载现有全局索引作为增量合并的基础
    const existingIndex = this.getGlobalIndex();
    const allVideos = new Map<string, FavoriteVideo>();
    for (const v of existingIndex) {
      allVideos.set(v.bvid, { ...v });
    }
    
    // 加载同步元数据
    const syncMetaMap = storage.getSyncMetaMap();
    const now = Date.now();
    
    // 已命中游标、无需继续翻页的文件夹
    const folderDone = new Set<number>();
    // 已成功同步的文件夹
    const syncedFolders = new Set<number>();
    
    const queue = new TaskQueue(5);
  
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
        // 带有指数退避的执行包装器
    const executeWithBackoff = async <T>(task: () => Promise<T>, maxRetries = 4): Promise<T> => {
      for (let i = 0; i <= maxRetries; i++) {
        try {
          return await queue.add(task);
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
  
    // Upsert 合并：将视频加入全局索引，正确处理多收藏夹归属并更新元信息
    const upsertVideo = (folderId: number, video: FavoriteVideo) => {
      if (!allVideos.has(video.bvid)) {
        allVideos.set(video.bvid, { ...video, folderIds: [folderId] });
      } else {
        const existing = allVideos.get(video.bvid)!;
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
    
    reportProgress();
    
    // ── 1. 并发获取所有活跃收藏夹的第一页 ──
    const activePlans = plans.filter(p => p.mode !== 'skip');
    
    const firstPageTasks = activePlans.map(plan =>
      executeWithBackoff(() => this.getVideos(plan.folder.id, 1, 20, force, signal))
        .then(res => {
          completedTasks++;
          processedVideos += res.list.length;
          reportProgress();
          return { plan, res };
        })
        .catch(err => {
          completedTasks++;
          reportProgress();
          throw err;
        })
    );
    
    const firstPageResults = await Promise.allSettled(firstPageTasks);
    const firstPages: Array<{ plan: FolderSyncPlan; res: PageResult<FavoriteVideo> }> = [];
    const firstPageErrors: string[] = [];
    for (const result of firstPageResults) {
      if (result.status === 'fulfilled') {
        firstPages.push(result.value);
      } else {
        firstPageErrors.push(result.reason?.message || '未知错误');
      }
    }
    if (firstPages.length === 0 && firstPageErrors.length > 0 && activePlans.length > 0) {
      throw new Error(`所有收藏夹第一页请求均失败: ${firstPageErrors.join('; ')}`);
    }
    
    const subsequentTasks: Array<() => Promise<void>> = [];
    
    // ── 2. 处理第一页结果，生成后续任务 ──
    for (const { plan, res } of firstPages) {
      const { folder, mode, cursorBvid } = plan;
      
      // 检查第一页是否命中游标（增量模式）
      if (mode === 'incremental' && cursorBvid) {
        const cursorIndex = res.list.findIndex((v: FavoriteVideo) => v.bvid === cursorBvid);
        if (cursorIndex === 0) {
          // 第一个视频就是游标 = 无新数据
          syncedFolders.add(folder.id);
          folderDone.add(folder.id);
          continue;
        }
        if (cursorIndex > 0) {
          // 游标在第一页中间 → 只取游标前的新视频
          for (const v of res.list.slice(0, cursorIndex)) {
            upsertVideo(folder.id, v);
          }
          syncedFolders.add(folder.id);
          folderDone.add(folder.id);
          syncMetaMap[folder.id] = {
            folderId: folder.id,
            lastSyncTime: now,
            latestBvid: res.list[0].bvid,
            mediaCount: folder.mediaCount,
          };
          continue;
        }
        // cursorIndex === -1，游标不在此页，需继续翻页
      }
      
      // 处理本页所有视频
      for (const v of res.list) {
        upsertVideo(folder.id, v);
      }
      
      // 更新游标为第一页第一个视频（最新）
      if (res.list.length > 0) {
        syncMetaMap[folder.id] = {
          folderId: folder.id,
          lastSyncTime: now,
          latestBvid: res.list[0].bvid,
          mediaCount: folder.mediaCount,
        };
      }
      syncedFolders.add(folder.id);
      
      // 生成后续页任务
      if (res.hasMore && !folderDone.has(folder.id)) {
        const totalPages = Math.ceil(folder.mediaCount / 20);
        for (let page = 2; page <= totalPages; page++) {
          subsequentTasks.push(async () => {
            // 如果游标已命中，跳过此任务
            if (folderDone.has(folder.id)) {
              completedTasks++;
              reportProgress();
              return;
            }
            try {
              const pageRes = await executeWithBackoff(() => this.getVideos(folder.id, page, 20, force, signal));
              
              if (mode === 'incremental' && cursorBvid) {
                const cursorIndex = pageRes.list.findIndex((v: FavoriteVideo) => v.bvid === cursorBvid);
                if (cursorIndex >= 0) {
                  // 命中游标 → 取游标前的视频，标记完成
                  for (const v of pageRes.list.slice(0, cursorIndex)) {
                    upsertVideo(folder.id, v);
                  }
                  folderDone.add(folder.id);
                  return;
                }
              }
              
              // 全量处理
              for (const v of pageRes.list) {
                upsertVideo(folder.id, v);
              }
              processedVideos += pageRes.list.length;
            } finally {
              completedTasks++;
              reportProgress();
            }
          });
        }
      }
    }
    
    // 计算总任务数（含已完成的 + 后续的）
    totalTasks = completedTasks + subsequentTasks.length;
    reportProgress();
  
    // ── 3. 执行所有后续任务 ──
    const subsequentResults = await Promise.allSettled(subsequentTasks.map(task => task()));
    const subsequentErrors: string[] = [];
    for (const result of subsequentResults) {
      if (result.status === 'rejected') {
        subsequentErrors.push(result.reason?.message || '未知错误');
      }
    }
    if (subsequentErrors.length > 0) {
      console.warn(`[favoriteService] 后续页面任务部分失败: ${subsequentErrors.join('; ')}`);
    }
    
    // ── 4. 容错保存：仅在数据成功收集后原子性写入 ──
    // 失败的任务不会影响已成功收集的数据
    storage.setJSON('globalIndex', Array.from(allVideos.values()));
    storage.setSyncMetaMap(syncMetaMap);
    
    console.log(`[favoriteService] 增量同步完成: 索引总数=${allVideos.size}, 同步文件夹=${syncedFolders.size}, 需校准=${dirtyCount}`);
  },

  /**
   * 获取全局索引
   */
  getGlobalIndex(): FavoriteVideo[] {
    return storage.getJSON<FavoriteVideo[]>('globalIndex') || [];
  },

  /**
   * 清理全局索引
   */
  clearGlobalIndex() {
    storage.delete('globalIndex');
  },
};
