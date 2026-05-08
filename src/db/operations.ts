import { database, playlistMetaCollection, videoMetaCollection, syncJobCollection } from './database';
import { Q } from '@nozbe/watermelondb';
import type { FavoriteVideo, VideoPart } from '../types/domain';

/**
 * 批量插入或更新视频记录（针对特定收藏夹）
 */
export async function upsertVideosBatch(playlistId: string, videos: FavoriteVideo[]): Promise<void> {
  if (!videos || videos.length === 0) return;

  await database.write(async writer => {
    const videoIds = videos.map(v => v.bvid).filter(Boolean);
    if (videoIds.length === 0) return;

    // 1. 批量查出当前批次在本地已存在的记录
    const existingRecords = await videoMetaCollection.query(
      Q.where('playlist_id', playlistId),
      Q.where('video_id', Q.oneOf(videoIds))
    ).fetch();

    const existingMap = new Map(existingRecords.map(r => [r.videoId, r]));
    const batchOperations: any[] = [];

    // 2. 区分 create 和 update 操作
    for (const video of videos) {
      const existing = existingMap.get(video.bvid);
      if (existing) {
        batchOperations.push(
          existing.prepareUpdate(v => {
            v.title = video.title;
            v.cover = video.cover;
            v.author = video.upper?.name || null;
            v.duration = video.duration;
            v.publishTime = video.pubtime;
            v.favTime = video.favTime;
            v.isDeleted = false; // 恢复软删除
            v.extraJson = JSON.stringify(video.parts || []);
          })
        );
      } else {
        batchOperations.push(
          videoMetaCollection.prepareCreate(v => {
            v.videoId = video.bvid;
            v.playlistId = playlistId;
            v.title = video.title;
            v.author = video.upper?.name || null;
            v.cover = video.cover;
            v.duration = video.duration;
            v.publishTime = video.pubtime;
            v.favTime = video.favTime;
            v.randomWeight = Math.random(); // 预生成随机权重
            v.isCached = false;
            v.isDeleted = false;
            v.extraJson = JSON.stringify(video.parts || []);
            v.syncedAt = new Date();
          })
        );
      }
    }

    // 3. 统一执行 database.batch()
    await writer.batch(...batchOperations);
  });
}

/**
 * 获取收藏夹元数据
 */
export async function getPlaylistMeta(playlistId: string) {
  const records = await playlistMetaCollection.query(
    Q.where('playlist_id', playlistId)
  ).fetch();
  return records.length > 0 ? records[0] : null;
}

/**
 * 获取所有收藏夹的同步元数据（用于 SyncDetailsScreen 展示）
 */
export async function getAllPlaylistMeta() {
  return await playlistMetaCollection.query().fetch();
}

/**
 * 彻底删除指定收藏夹的所有数据（元数据 + 关联视频 + 同步任务）
 */
export async function deletePlaylistAndVideos(playlistId: string): Promise<void> {
  await database.write(async writer => {
    const batchOperations: any[] = [];

    // 删除收藏夹元数据
    const metas = await playlistMetaCollection.query(
      Q.where('playlist_id', playlistId)
    ).fetch();
    for (const meta of metas) {
      batchOperations.push(meta.prepareMarkAsDeleted());
    }

    // 删除关联的视频记录
    const videos = await videoMetaCollection.query(
      Q.where('playlist_id', playlistId)
    ).fetch();
    for (const video of videos) {
      batchOperations.push(video.prepareMarkAsDeleted());
    }

    // 删除关联的同步任务
    const jobs = await syncJobCollection.query(
      Q.where('playlist_id', playlistId)
    ).fetch();
    for (const job of jobs) {
      batchOperations.push(job.prepareMarkAsDeleted());
    }

    if (batchOperations.length > 0) {
      await writer.batch(...batchOperations);
    }
  });
}

/**
 * 创建或更新收藏夹元数据
 */
export async function upsertPlaylistMeta(data: {
  playlistId: string;
  title?: string;
  remoteVideoCount: number;
  remoteRevision?: string;
  syncStatus?: string;
  needResync?: boolean;
}) {
  await database.write(async writer => {
    const existing = await getPlaylistMeta(data.playlistId);
    if (existing) {
      await existing.update(record => {
        if (data.title) record.title = data.title;
        record.remoteVideoCount = data.remoteVideoCount;
        if (data.remoteRevision) record.remoteRevision = data.remoteRevision;
        if (data.syncStatus) record.syncStatus = data.syncStatus;
        if (data.needResync !== undefined) record.needResync = data.needResync;
      });
    } else {
      await playlistMetaCollection.create(record => {
        record.playlistId = data.playlistId;
        record.title = data.title || '';
        record.remoteVideoCount = data.remoteVideoCount;
        record.localSyncedCount = 0;
        record.remoteRevision = data.remoteRevision || null;
        record.syncStatus = data.syncStatus || 'idle';
        record.needResync = data.needResync || false;
      });
    }
  });
}

/**
 * 更新收藏夹同步游标和已同步数量（使用绝对数量）
 */
export async function updatePlaylistSyncProgress(playlistId: string, cursor: string | null, absoluteSyncedCount: number) {
  await database.write(async writer => {
    const meta = await getPlaylistMeta(playlistId);
    if (meta) {
      await meta.update(record => {
        record.syncCursor = cursor;
        record.localSyncedCount = absoluteSyncedCount;
      });
    }
  });
}

/**
 * 获取收藏夹下有效视频的数量
 */
export async function getPlaylistVideoCount(playlistId: string): Promise<number> {
  return await videoMetaCollection.query(
    Q.where('playlist_id', playlistId),
    Q.where('is_deleted', false)
  ).fetchCount();
}

/**
 * 标记收藏夹同步完成
 */
export async function markPlaylistSyncSuccess(playlistId: string) {
  await database.write(async writer => {
    const meta = await getPlaylistMeta(playlistId);
    if (meta) {
      await meta.update(record => {
        record.syncStatus = 'success';
        record.lastSyncedAt = new Date();
        record.needResync = false;
        record.syncCursor = null; // 清空游标
      });
    }
  });
}

/**
 * 创建同步任务
 */
export async function createSyncJob(playlistId: string, snapshotRevision: string | null) {
  let jobId = '';
  await database.write(async writer => {
    const job = await syncJobCollection.create(record => {
      record.jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      record.playlistId = playlistId;
      record.status = 'running';
      record.snapshotRevision = snapshotRevision;
      record.syncedCount = 0;
      record.startedAt = new Date();
    });
    jobId = job.jobId;
  });
  return jobId;
}

/**
 * 更新同步任务状态
 */
export async function finishSyncJob(jobId: string, status: 'success' | 'failed' | 'cancelled', failedReason?: string) {
  await database.write(async writer => {
    const records = await syncJobCollection.query(Q.where('job_id', jobId)).fetch();
    if (records.length > 0) {
      await records[0].update(record => {
        record.status = status;
        record.finishedAt = new Date();
        if (failedReason) record.failedReason = failedReason;
      });
    }
  });
}

/**
 * 执行软删除：将本地存在但远端不存在的视频标记为已删除
 */
export async function softDeleteMissingVideos(playlistId: string, remoteVideoIds: string[]) {
  await database.write(async writer => {
    // 获取本地该收藏夹下所有未删除的视频
    const localVideos = await videoMetaCollection.query(
      Q.where('playlist_id', playlistId),
      Q.where('is_deleted', false)
    ).fetch();

    const remoteSet = new Set(remoteVideoIds);
    const batchOperations: any[] = [];

    for (const video of localVideos) {
      if (!remoteSet.has(video.videoId)) {
        batchOperations.push(
          video.prepareUpdate(v => {
            v.isDeleted = true;
          })
        );
      }
    }

    if (batchOperations.length > 0) {
      await writer.batch(...batchOperations);
    }
  });
}

/**
 * 获取所有有效视频（未删除）
 */
export async function getAllValidVideos() {
  return await videoMetaCollection.query(
    Q.where('is_deleted', false),
    Q.sortBy('fav_time', Q.desc)
  ).fetch();
}

/**
 * 获取收藏夹下的所有有效视频（未删除）
 */
export async function getVideosByPlaylistId(playlistId: string) {
  return await videoMetaCollection.query(
    Q.where('playlist_id', playlistId),
    Q.where('is_deleted', false),
    Q.sortBy('fav_time', Q.desc)
  ).fetch();
}

/**
 * 随机获取一批视频（用于随机播放队列）
 */
export async function getRandomVideosBatch(playlistId?: string, limit: number = 50) {
  const randomVal = Math.random();
  
  let queryArgs: Q.Clause[] = [
    Q.where('is_deleted', false),
    Q.where('random_weight', Q.gt(randomVal)),
    Q.sortBy('random_weight', Q.asc),
    Q.take(limit)
  ];

  if (playlistId) {
    queryArgs.unshift(Q.where('playlist_id', playlistId));
  }

  let records = await videoMetaCollection.query(...queryArgs).fetch();

  // 如果数量不够，回绕从头找补充
  if (records.length < limit) {
    const remaining = limit - records.length;
    let fallbackArgs: Q.Clause[] = [
      Q.where('is_deleted', false),
      Q.sortBy('random_weight', Q.asc),
      Q.take(remaining)
    ];
    if (playlistId) {
      fallbackArgs.unshift(Q.where('playlist_id', playlistId));
    }
    const fallbackRecords = await videoMetaCollection.query(...fallbackArgs).fetch();
    
    // 去重合并
    const seen = new Set(records.map(r => r.videoId));
    for (const r of fallbackRecords) {
      if (!seen.has(r.videoId)) {
        records.push(r);
        seen.add(r.videoId);
      }
    }
  }

  return records;
}

/**
 * 清除所有数据
 */
export async function clearAllData(): Promise<void> {
  await database.write(async writer => {
    await playlistMetaCollection.query().markAllAsDeleted();
    await videoMetaCollection.query().markAllAsDeleted();
    await syncJobCollection.query().markAllAsDeleted();
  });
}

/**
 * 持久化视频分P信息到数据库 extra_json 字段。
 *
 * 当 lazyResolve 解析出多P视频时调用，将 parts（包含各分P的 cid、title、duration）
 * 写入 WatermelonDB 的 extra_json 列。下次冷启动时，buildPlaceholderTrack 直接从 DB
 * 读取 parts 数据并注入 cid 到占位符 URL，使 lazyResolve 跳过首次 videoInfo 请求，
 * 减少 1 RTT，显著提升加载速度。
 *
 * 如果数据库中不存在该视频记录（尚未同步完成），则静默跳过。
 */
export async function persistVideoPartsToDb(bvid: string, parts: VideoPart[]): Promise<void> {
  await database.write(async writer => {
    const records = await videoMetaCollection.query(Q.where('video_id', bvid)).fetch();
    if (records.length === 0) return;
    const updates = records.map(record =>
      record.prepareUpdate(v => {
        v.extraJson = JSON.stringify(parts);
      })
    );
    await writer.batch(...updates);
  });
}
