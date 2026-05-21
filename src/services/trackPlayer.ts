import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event,
  IOSCategory, IOSCategoryMode, IOSCategoryOptions,
  Track, State
} from 'react-native-track-player';
import { AppState } from 'react-native';
import LoggerService from './LoggerService';
import { audioService } from './audioService';
import { audioCache } from './audioCache';
import { netStatus } from './netStatus';
import { useSettingsStore } from '../store/settingsStore';
import { config } from '../config';
import { usePlayerStore } from '../store/playerStore';
import { performanceMonitor } from './performanceMonitor';
import type { FavoriteVideo } from '../types/domain';
import { storage } from '../core/storage';
import { useProgressStore } from '../store/progressStore';
import { getCachedUrl, setCachedUrl } from './urlCache';
import { persistVideoPartsToDb } from '../db/operations';

let _ready = false;

export async function setupPlayer() {
  if (_ready) return;
  try {
    const mixWithOthers = useSettingsStore.getState().mixWithOthers;
    await TrackPlayer.setupPlayer({
      autoHandleInterruptions: !mixWithOthers,
      iosCategory: IOSCategory.Playback,
      iosCategoryMode: IOSCategoryMode.Default,
      iosCategoryOptions: mixWithOthers ? [IOSCategoryOptions.MixWithOthers] : [],
    });
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback,
      },
      color: 0xFFFB7299,
      capabilities: [
        Capability.Play, Capability.Pause,
        Capability.SkipToNext, Capability.SkipToPrevious,
        Capability.SeekTo, Capability.Stop,
      ],
      compactCapabilities: [
        Capability.Play, Capability.Pause, Capability.SkipToNext,
      ],
      notificationCapabilities: [
        Capability.Play, Capability.Pause,
        Capability.SkipToNext, Capability.SkipToPrevious,
      ],
      progressUpdateEventInterval: 1,
    });

    AppState.addEventListener('change', async (nextAppState) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        try {
          const progress = useProgressStore.getState();
          if (progress.position > 0) {
            storage.setNumber('lastPlaybackPosition', progress.position);
          }
        } catch (e) {}
      }
    });

    if (!usePlayerStore.persist.hasHydrated()) {
      await new Promise<void>((resolve) => {
        const unsub = usePlayerStore.persist.onFinishHydration(() => {
          unsub();
          resolve();
        });
      });
    }

    const store = usePlayerStore.getState();
    if (store.queue && store.queue.length > 0 && store.currentBvid) {
      try {
        const currentBvid = store.currentBvid;
        const currentIdx = store.queue.findIndex((v) => v.bvid === currentBvid);
        
        if (currentIdx !== -1) {
          const targetVideo = store.queue[currentIdx];
          const realTracks = await hydrateVideo(targetVideo);
          if (realTracks.length > 0) {
            await TrackPlayer.reset();
            await TrackPlayer.add(realTracks);
            
            const lastPosition = storage.getNumber('lastPlaybackPosition');
            if (lastPosition && lastPosition > 0) {
              await TrackPlayer.seekTo(lastPosition);
            }
            await TrackPlayer.pause();
            
            // 异步水合后续轨道
            hydrateNextTracks(store.queue, currentIdx, 2).catch(() => {});
          }
        }
      } catch (e) {
        LoggerService.error('TrackPlayer', 'setupPlayer', 'Cold start hydration failed', e);
      }
    }

  } catch (e) {
    LoggerService.error('TrackPlayer', 'setupPlayer', 'setupPlayer error:', e);
  }
  _ready = true;
}

async function hydrateVideo(v: FavoriteVideo, targetCid?: number): Promise<Track[]> {
  try {
    const quality = useSettingsStore.getState().quality;
    const cid = targetCid ?? (v.parts && v.parts.length > 0 ? v.parts[0].cid : undefined);
    
    const cacheKey = cid ? `${v.bvid}-${cid}` : v.bvid;
    const isNoCache = v.folderIds?.some(id => useSettingsStore.getState().noCacheFolderIds?.includes(id)) ?? false;
    
    let url = '';
    let headers: Record<string, string> | undefined;
    let effectiveCid = cid;
    let title = v.title;
    let partsToExpand: any[] = [];

    const cachedPath = !isNoCache ? await audioCache.has(cacheKey, quality) : null;
    if (cachedPath) {
      url = `file://${cachedPath}`;
    } else {
      const cachedUrlEntry = getCachedUrl(v.bvid, cid);
      if (cachedUrlEntry) {
        url = cachedUrlEntry.url;
        headers = cachedUrlEntry.headers;
        // effectiveCid = cachedUrlEntry.cid; // CachedUrlEntry doesn't have cid, it's in the key
      } else {
        const info = await audioService.getInfo(v.bvid, quality, cid);
        url = info.audio.baseUrl;
        headers = { Referer: config.referer, 'User-Agent': config.userAgent };
        effectiveCid = cid ?? info.cid;
        setCachedUrl(v.bvid, url, headers, effectiveCid);
        
        if (!isNoCache) {
          audioCache.download(cacheKey, quality, url, headers).catch(() => {});
        }
        
        if (!cid && info.parts && info.parts.length > 1) {
          title = `${info.title} - ${info.parts[0].title}`;
          usePlayerStore.getState().updateVideoParts(v.bvid, info.parts);
          persistVideoPartsToDb(v.bvid, info.parts).catch(() => {});
          if (useSettingsStore.getState().expandMultiPart) {
            partsToExpand = info.parts.slice(1);
          }
        }
      }
    }

    const tracks: Track[] = [{
      id: v.bvid,
      url: url,
      title: title,
      artist: v.upper?.name || '未知作者',
      artwork: v.cover,
      duration: v.duration,
      userAgent: config.userAgent,
      headers: headers,
      cid: effectiveCid,
    } as Track];

    if (partsToExpand.length > 0) {
      const partTracks = await Promise.all(partsToExpand.map(async (part) => {
         const partInfo = await audioService.getInfo(v.bvid, quality, part.cid);
         return {
            id: v.bvid,
            url: partInfo.audio.baseUrl,
            title: `${v.title} - ${part.title}`,
            artist: v.upper?.name || '未知作者',
            artwork: v.cover,
            duration: part.duration,
            userAgent: config.userAgent,
            headers: { Referer: config.referer, 'User-Agent': config.userAgent },
            cid: part.cid,
         } as Track;
      }));
      tracks.push(...partTracks);
    }

    return tracks;
  } catch (error) {
    LoggerService.error('TrackPlayer', 'hydrateVideo', `Failed to hydrate ${v.bvid}`, error);
    return [];
  }
}

async function hydrateNextTracks(logicalQueue: FavoriteVideo[], logicalCurrentIndex: number, count: number = 2) {
  const nativeQueue = await TrackPlayer.getQueue();
  const nativeIds = new Set(nativeQueue.map(t => t.id));
  
  const tracksToAdd: Track[] = [];
  let addedCount = 0;
  let i = logicalCurrentIndex + 1;
  
  // 循环直到成功添加了 count 个有效轨道，或者遍历完整个逻辑队列
  while (addedCount < count && i < logicalQueue.length) {
    const video = logicalQueue[i];
    if (!nativeIds.has(video.bvid)) {
      const tracks = await hydrateVideo(video);
      if (tracks.length > 0) {
        tracksToAdd.push(...tracks);
        nativeIds.add(video.bvid);
        addedCount++;
      } else {
        LoggerService.warn('TrackPlayer', 'hydrateNextTracks', `跳过失效视频: ${video.bvid}`);
      }
    } else {
      // 如果已经在原生队列中，也算作一个有效轨道
      addedCount++;
    }
    i++;
  }
  
  if (tracksToAdd.length > 0) {
    await TrackPlayer.add(tracksToAdd);
  }
}

export async function loadQueue(videos: FavoriteVideo[], startBvid?: string): Promise<number> {
  if (!videos || videos.length === 0) return 0;

  usePlayerStore.getState().setResolving(true);
  try {
    const startIndex = Math.max(0, startBvid ? videos.findIndex((v) => v.bvid === startBvid) : 0);
    
    // 初始水合窗口：前1首 + 当前首 + 后2首
    const windowStart = Math.max(0, startIndex - 1);
    const windowEnd = Math.min(videos.length, startIndex + 3);
    const windowVideos = videos.slice(windowStart, windowEnd);

    const hydratedTracksArrays = await Promise.all(
      windowVideos.map(v => hydrateVideo(v))
    );
    const hydratedTracks = hydratedTracksArrays.flat();

    if (hydratedTracks.length === 0) {
      usePlayerStore.getState().setPlaybackError('加载音频失败，请检查网络');
      return 0;
    }

    await TrackPlayer.reset();
    await TrackPlayer.add(hydratedTracks);
    
    // 计算目标轨道在原生队列中的索引
    // 注意：如果前面的视频有多P展开，索引计算会复杂。这里简化处理，直接按 bvid 查找
    const targetBvid = videos[startIndex].bvid;
    const targetNativeIndex = hydratedTracks.findIndex(t => t.id === targetBvid);
    
    if (targetNativeIndex !== -1) {
      await TrackPlayer.skip(targetNativeIndex);
      if (hydratedTracks[targetNativeIndex]) {
         autoCache(hydratedTracks[targetNativeIndex].id as string);
      }
    } else {
      await TrackPlayer.skip(0);
    }
    
    await TrackPlayer.play();

    usePlayerStore.getState().setQueue(videos, startBvid);
    return 1;
  } finally {
    usePlayerStore.getState().setResolving(false);
  }
}

export async function playWithIntent(): Promise<void> {
  await TrackPlayer.play();
}

export async function resolveCurrentTrack(version: number): Promise<void> {
  // 废弃
}

export async function insertNext(video: FavoriteVideo): Promise<void> {
  const cur = usePlayerStore.getState();
  const logicalQueue = [...cur.queue];
  
  const activeTrack = await TrackPlayer.getActiveTrack();
  const currentBvid = activeTrack?.id as string | undefined;
  
  let insertPos = logicalQueue.length;
  if (currentBvid) {
    const idx = logicalQueue.findIndex(v => v.bvid === currentBvid);
    if (idx !== -1) insertPos = idx + 1;
  }
  
  logicalQueue.splice(insertPos, 0, video);
  cur.setQueue(logicalQueue, cur.currentBvid ?? undefined);
  
  const activeIndex = await TrackPlayer.getActiveTrackIndex();
  if (typeof activeIndex === 'number') {
     const realTracks = await hydrateVideo(video);
     if (realTracks.length > 0) {
       // 插入到当前播放轨道之后
       await TrackPlayer.add(realTracks, activeIndex + 1);
     }
  }
}

export async function removeFromQueue(bvid: string): Promise<void> {
  const cur = usePlayerStore.getState();
  const filtered = cur.queue.filter((v) => v.bvid !== bvid);
  cur.setQueue(filtered, cur.currentBvid ?? undefined);

  const nativeQueue = await TrackPlayer.getQueue();
  // 可能有多P，需要移除所有匹配的
  const indicesToRemove: number[] = [];
  nativeQueue.forEach((t, idx) => {
    if (t.id === bvid) indicesToRemove.push(idx);
  });
  
  if (indicesToRemove.length > 0) {
    await TrackPlayer.remove(indicesToRemove);
  }
}

export async function reorderQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  if (videos.length === 0) return;
  
  const cur = usePlayerStore.getState();
  cur.setQueue(videos, startBvid ?? cur.currentBvid ?? undefined);

  const activeTrack = await TrackPlayer.getActiveTrack();
  const currentBvid = activeTrack?.id as string | undefined;
  
  if (!currentBvid) {
    await loadQueue(videos, startBvid);
    return;
  }

  const newCurrentIndex = videos.findIndex(v => v.bvid === currentBvid);
  if (newCurrentIndex === -1) {
    await loadQueue(videos, startBvid);
    return;
  }

  const nativeQueue = await TrackPlayer.getQueue();
  const indicesToRemove: number[] = [];
  nativeQueue.forEach((t, idx) => {
    if (t.id !== currentBvid) indicesToRemove.push(idx);
  });
  if (indicesToRemove.length > 0) {
    await TrackPlayer.remove(indicesToRemove);
  }

  hydrateNextTracks(videos, newCurrentIndex, 2).catch(() => {});
}

export async function appendQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  if (videos.length === 0) return;
  
  const cur = usePlayerStore.getState();
  const combined = [...cur.queue, ...videos];
  cur.setQueue(combined, startBvid ?? cur.currentBvid ?? undefined);

  const activeTrack = await TrackPlayer.getActiveTrack();
  if (activeTrack?.id) {
    const logicalIndex = combined.findIndex(v => v.bvid === activeTrack.id);
    if (logicalIndex !== -1) {
      hydrateNextTracks(combined, logicalIndex, 2).catch(() => {});
    }
  }
}

async function autoCache(bvid: string, cid?: number) {
  const s = useSettingsStore.getState();
  if (!s.autoCacheOnWifi || !netStatus.isWifi()) return;
  
  const videoInQueue = usePlayerStore.getState().queue.find(v => v.bvid === bvid);
  const isNoCache = videoInQueue?.folderIds?.some(id => s.noCacheFolderIds?.includes(id)) ?? false;
  if (isNoCache) return;

  const cacheKey = cid ? `${bvid}-${cid}` : bvid;
  if (await audioCache.has(cacheKey, s.quality)) return;
  try {
    const info = await audioService.getInfo(bvid, s.quality, cid);
    await audioCache.download(cacheKey, s.quality, info.audio.baseUrl, {
      Referer: config.referer, 'User-Agent': config.userAgent,
    });
  } catch {}
}

export async function resumePlayback(): Promise<void> {
  await TrackPlayer.play().catch(() => {});
}

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  
  // 极简切歌：原生队列中已经是真实 URL，直接 skip
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    await TrackPlayer.skipToNext().catch(() => {});
    await TrackPlayer.play().catch(() => {});
  });
  
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    await TrackPlayer.skipToPrevious().catch(() => {});
    await TrackPlayer.play().catch(() => {});
  });
  
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position)
  );

  TrackPlayer.addEventListener(Event.PlaybackState, async (playbackState) => {
    const playerState = (playbackState as any).state;

    if (playerState === State.Paused || playerState === State.Stopped) {
      try {
        const progress = useProgressStore.getState();
        if (progress.position > 0) {
          storage.setNumber('lastPlaybackPosition', progress.position);
        }
      } catch (e) {}
    }

    const activeTrack = await TrackPlayer.getActiveTrack();
    if (!activeTrack?.id) return;
    const bvid = activeTrack.id as string;
    if (playerState === State.Playing) {
      performanceMonitor.firstFrame(bvid);
      performanceMonitor.stallEnd(bvid);
    } else if (playerState === State.Buffering) {
      performanceMonitor.stallStart(bvid);
    }
  });

  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (e) => {
    if (e.index === undefined) return;

    const activeTrack = await TrackPlayer.getActiveTrack();
    if (!activeTrack?.id) return;

    const bvid = activeTrack.id as string;
    usePlayerStore.getState().setCurrentBvid(bvid);

    const trackCid = (activeTrack as any).cid;
    if (typeof trackCid === 'number') {
      usePlayerStore.getState().setCurrentCid(trackCid);
    } else {
      usePlayerStore.getState().setCurrentCid(null);
    }

    usePlayerStore.getState().setResolving(false);
    if (e.lastTrack?.id) autoCache(e.lastTrack.id as string);

    // 动态水合逻辑：当播放到新轨道时，检查并水合后续轨道
    const logicalQueue = usePlayerStore.getState().queue;
    const logicalIndex = logicalQueue.findIndex(v => v.bvid === bvid);
    if (logicalIndex !== -1) {
      const nativeQueue = await TrackPlayer.getQueue();
      const nativeIndex = await TrackPlayer.getActiveTrackIndex();
      
      if (typeof nativeIndex === 'number') {
        const remainingInNative = nativeQueue.length - 1 - nativeIndex;
        if (remainingInNative < 2) {
          hydrateNextTracks(logicalQueue, logicalIndex, 2).catch(err => {
            LoggerService.error('TrackPlayer', 'PlaybackActiveTrackChanged', 'Hydration failed', err);
          });
        }
      }
    }
  });

  TrackPlayer.addEventListener(Event.PlaybackError, async (error) => {
    LoggerService.error('TrackPlayer', 'PlaybackError', '播放错误:', error);
    usePlayerStore.getState().setPlaybackError('播放失败，请检查网络或重试');
    await TrackPlayer.pause();
  });
}

export async function playSpecificPart(bvid: string, cid: number, partTitle: string) {
  usePlayerStore.getState().setResolving(true);
  try {
    const expandMultiPart = useSettingsStore.getState().expandMultiPart;
    const currentQueue = await TrackPlayer.getQueue();
    
    const existingIndex = currentQueue.findIndex(t => t.id === bvid && (t as any).cid === cid);

    if (existingIndex !== -1) {
      await TrackPlayer.skip(existingIndex);
      await TrackPlayer.play();
      usePlayerStore.getState().setCurrentCid(cid);
      return;
    }

    const logicalQueue = usePlayerStore.getState().queue;
    const video = logicalQueue.find(v => v.bvid === bvid);
    if (!video) return;

    const realTracks = await hydrateVideo(video, cid);
    if (realTracks.length === 0) {
      usePlayerStore.getState().setPlaybackError('加载分P失败');
      return;
    }
    const realTrack = realTracks[0];
    realTrack.title = `${video.title} - ${partTitle}`;

    const rawIdx = await TrackPlayer.getActiveTrackIndex();
    const idx = typeof rawIdx === 'number' ? rawIdx : -1;

    if (expandMultiPart) {
      const insertPos = idx >= 0 ? idx + 1 : 0;
      await TrackPlayer.add(realTrack, insertPos);
      await TrackPlayer.skip(insertPos);
    } else {
      if (idx === -1) {
        await TrackPlayer.add(realTrack, 0);
        await TrackPlayer.skip(0);
      } else {
        await TrackPlayer.add(realTrack, idx + 1);
        await TrackPlayer.skip(idx + 1);
        await TrackPlayer.remove(idx);
      }
    }
    await TrackPlayer.play();
    usePlayerStore.getState().setCurrentCid(cid);
  } finally {
    usePlayerStore.getState().setResolving(false);
  }
}
