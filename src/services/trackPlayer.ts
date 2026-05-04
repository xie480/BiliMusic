import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event,
} from 'react-native-track-player';
import { audioService } from './audioService';
import { audioCache } from './audioCache';
import { netStatus } from './netStatus';
import { useSettingsStore } from '../store/settingsStore';
import { config } from '../config';
import { usePlayerStore } from '../store/playerStore';
import { performanceMonitor } from './performanceMonitor';
import { State } from 'react-native-track-player';
import type { FavoriteVideo } from '../types/domain';
// 用于防止同一索引的 lazyResolve 并发执行，避免重复替换
const resolving = new Set<number>();

let _ready = false;

export async function setupPlayer() {
  if (_ready) return;
  try {
    await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play, Capability.Pause,
        Capability.SkipToNext, Capability.SkipToPrevious,
        Capability.SeekTo, Capability.Stop,
      ],
      compactCapabilities: [
        Capability.Play, Capability.Pause, Capability.SkipToNext,
      ],
      progressUpdateEventInterval: 1,
    });
  } catch {}
  _ready = true;
}

// buildTrack removed – placeholder logic used in loadQueue

export async function loadQueue(videos: FavoriteVideo[], startBvid?: string) {
  if (!videos || videos.length === 0) return; // 新增边界保护
  await TrackPlayer.reset();
  const startIndex = Math.max(0, videos.findIndex((v) => v.bvid === startBvid));

  const tracks = videos.map((v) => ({
    id: v.bvid,
    url: `placeholder://${v.bvid}`,
    title: v.title,
    artist: v.upper.name,
    artwork: v.cover,
    duration: v.duration,
  }));
  await TrackPlayer.add(tracks);
  await TrackPlayer.skip(startIndex);
  // Resolve the placeholder for the current track
  await lazyResolve(startIndex);
  // 预加载下一首（若存在），减少切歌时网络延迟
  if (videos.length > startIndex + 1) {
    lazyResolve(startIndex + 1).catch(() => {});
  }
}

/**
 * Insert a video to be played next after the current track.
 */
export async function insertNext(video: FavoriteVideo): Promise<void> {
  const rawIdx = await TrackPlayer.getActiveTrackIndex();
  const idx = typeof rawIdx === 'number' ? rawIdx : -1;
  const nativeQueue = await TrackPlayer.getQueue();
  const insertPos = idx >= 0 ? idx + 1 : nativeQueue.length;
  await TrackPlayer.add(
    {
      id: video.bvid,
      url: `placeholder://${video.bvid}`,
      title: video.title,
      artist: video.upper.name,
      artwork: video.cover,
      duration: video.duration,
    },
    insertPos
  );
  // Update Zustand store synchronized queue
  const cur = usePlayerStore.getState();
  const newQueue = [...cur.queue];
  newQueue.splice(insertPos, 0, video);
  cur.setQueue(newQueue, cur.currentBvid ?? undefined);
}

/**
 * Remove a specific video from the queue by its BVID.
 */
export async function removeFromQueue(bvid: string): Promise<void> {
  const nativeQueue = await TrackPlayer.getQueue();
  const idx = nativeQueue.findIndex((t) => t.id === bvid);
  if (idx !== -1) {
    await TrackPlayer.remove(idx);
    const cur = usePlayerStore.getState();
    const filtered = cur.queue.filter((v) => v.bvid !== bvid);
    cur.setQueue(filtered, cur.currentBvid ?? undefined);
  }
}

/**
 * Reorder the entire queue. Optionally start playing from a specific BVID.
 */
export async function reorderQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  // Rebuild the queue using loadQueue to keep placeholder logic
  await loadQueue(videos, startBvid);
}

/**
 * Append a batch of videos to the end of the queue.
 */
export async function appendQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  for (const v of videos) {
    await TrackPlayer.add({
      id: v.bvid,
      url: `placeholder://${v.bvid}`,
      title: v.title,
      artist: v.upper.name,
      artwork: v.cover,
      duration: v.duration,
    });
  }
  const cur = usePlayerStore.getState();
  const combined = [...cur.queue, ...videos];
  cur.setQueue(combined, startBvid ?? cur.currentBvid ?? undefined);
}

async function lazyResolve(index: number) {
  // 防止同一索引并发解析导致重复替换
  if (resolving.has(index)) return;
  resolving.add(index);
  let bvid = '';
  try {
    const queue = await TrackPlayer.getQueue();
    const t = queue[index];
    if (!t || !String(t.url).startsWith('placeholder://')) return;
    
    const rawId = String(t.url).replace('placeholder://', '');
    const [extractedBvid, cidStr] = rawId.split('-');
    bvid = extractedBvid;
    const cid = cidStr ? parseInt(cidStr, 10) : undefined;
    // 记录轨道开始加载时间
    performanceMonitor.start(bvid);
    const quality = useSettingsStore.getState().quality;
    const cacheKey = cid ? `${bvid}-${cid}` : bvid;
    
    let url: string;
    let headers: Record<string, string> | undefined;
    let resolvedInfo: any = undefined;
    
    const cachedPath = await audioCache.has(cacheKey, quality);
    if (cachedPath) {
      url = `file://${cachedPath}`;
    } else {
      resolvedInfo = await audioService.getInfo(bvid, quality, cid);
      const downloadedPath = await audioCache.download(cacheKey, quality, resolvedInfo.audio.baseUrl, {
        Referer: config.referer,
        'User-Agent': config.userAgent,
      });
      url = `file://${downloadedPath}`;
      // 触发后台自动下载（如在 Wi‑Fi 环境下）保持已有逻辑
      autoCache(bvid, cid).catch(() => {});
    }

    // 多P视频动态队列展开：仅在根占位符（未指定cid）时执行
    let videoInfo: any;
    if (!cid) {
      videoInfo = resolvedInfo || await audioService.getInfo(bvid, quality);
      const parts = videoInfo?.parts;
      if (parts && parts.length > 1) {
        usePlayerStore.getState().updateVideoParts(bvid, parts);
        usePlayerStore.getState().setCurrentCid(parts[0].cid);
        // 获取当前队列快照，找到根占位符的位置
        const expandQueue = await TrackPlayer.getQueue();
        const currentIdx = expandQueue.findIndex(
          tr => tr.id === bvid && String(tr.url).startsWith('placeholder://')
        );
        if (currentIdx !== -1) {
          // 将第2P及之后的分P作为占位符插入到当前轨道之后（倒序插入保持顺序）
          const remainingParts = parts.slice(1);
          for (let i = remainingParts.length - 1; i >= 0; i--) {
            const part = remainingParts[i];
            await TrackPlayer.add({
              id: bvid,
              url: `placeholder://${bvid}-${part.cid}`,
              title: `${videoInfo.title} - ${part.title}`,
              artist: videoInfo.author,
              artwork: videoInfo.cover,
              duration: part.duration,
              cid: part.cid,
            }, currentIdx + 1);
          }
        }
      }
    }

    // 动态查找当前 placeholder 的实际索引，防止队列变化导致 index 失效
    const freshQueue = await TrackPlayer.getQueue();
    const actualIndex = freshQueue.findIndex(tr => tr.id === bvid && String(tr.url).startsWith('placeholder://'));
    if (actualIndex === -1) {
      return; // 找不到对应的 placeholder，可能已被用户操作移出队列或已解析
    }

    // 如果是多P视频的根占位符，替换为第一P的标题
    let title = t.title;
    if (!cid && videoInfo?.parts && videoInfo.parts.length > 0) {
      title = `${videoInfo.title} - ${videoInfo.parts[0].title}`;
    }
    const newTrack: any = { ...t, url, title, userAgent: config.userAgent, headers, cid };
    // 平滑替换策略：先在 actualIndex 后面插入新 track，跳过去，再删掉原来的 placeholder
    await TrackPlayer.add(newTrack, actualIndex + 1);
    const postAddActiveTrackIndex = await TrackPlayer.getActiveTrackIndex();
    if (postAddActiveTrackIndex !== undefined && postAddActiveTrackIndex === actualIndex) {
      await TrackPlayer.skip(actualIndex + 1);
      await TrackPlayer.play(); // 确保播放恢复
    }
    await TrackPlayer.remove(actualIndex);
  } catch (error) {
    console.error(`[TrackPlayer] 解析音频失败 (BVID: ${bvid}):`, error);
    
    // 检查网络状态，如果是无网导致的失败，停止播放并避免切歌风暴
    if (netStatus.type === 'none' || netStatus.type === 'unknown') {
      console.warn('[TrackPlayer] 无网络连接，停止解析队列');
      await TrackPlayer.pause();
      // 通过 Zustand store 触发全局 UI 错误提示
      usePlayerStore.getState().setPlaybackError('无网络连接，无法加载音频');
      return;
    }

    // 解析失败时自动跳到下一首（仅当当前播放的确实是解析失败的这首歌）
    const activeTrackIndex = await TrackPlayer.getActiveTrackIndex();
    const freshQueue = await TrackPlayer.getQueue();
    const activeTrack = typeof activeTrackIndex === 'number' ? freshQueue[activeTrackIndex] : undefined;
    
    if (activeTrack && activeTrack.id === bvid) {
      await TrackPlayer.skipToNext().catch(() => {});
    }
  } finally {
    resolving.delete(index);
  }
}

async function autoCache(bvid: string, cid?: number) {
  const s = useSettingsStore.getState();
  if (!s.autoCacheOnWifi || !netStatus.isWifi()) return;
  const cacheKey = cid ? `${bvid}-${cid}` : bvid;
  if (await audioCache.has(cacheKey, s.quality)) return;
  try {
    const info = await audioService.getInfo(bvid, s.quality, cid);
    await audioCache.download(cacheKey, s.quality, info.audio.baseUrl, {
      Referer: config.referer, 'User-Agent': config.userAgent,
    });
  } catch {}
}

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position)
  );

  // Performance monitoring: track playback state changes
  TrackPlayer.addEventListener(Event.PlaybackState, async (playbackState) => {
    // playbackState is of type PlaybackState, with .state property.
    const playerState = (playbackState as any).state;
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
    // Record start of track loading/playback
    const activeTrack = await TrackPlayer.getActiveTrack();
    if (activeTrack?.id) {
      performanceMonitor.start(activeTrack.id as string);
      // 提取当前播放轨道的 cid，更新到 store
      if (activeTrack.url && typeof activeTrack.url === 'string') {
        const urlStr = activeTrack.url;
        if (urlStr.startsWith('placeholder://')) {
          const rawId = urlStr.replace('placeholder://', '');
          const parts = rawId.split('-');
          if (parts.length >= 2) {
            const cid = parseInt(parts[1], 10);
            if (!isNaN(cid)) {
              usePlayerStore.getState().setCurrentCid(cid);
            }
          }
        }
      }
    }
    if (e.index !== undefined) {
      await lazyResolve(e.index);
      // prefetch next track if exists for seamless playback
      try {
        const queue = await TrackPlayer.getQueue();
        if (e.index + 1 < queue.length) {
          lazyResolve(e.index + 1).catch(() => {});
        }
      } catch {}
    }
    if (e.lastTrack?.id) autoCache(e.lastTrack.id as string);
  });
  // 【修复】增加错误监听，遇到播放错误自动跳过
  TrackPlayer.addEventListener(Event.PlaybackError, async (error) => {
    // Revised handling: determine if error originates from a placeholder track by inspecting the active track URL
    try {
      const activeIndex = await TrackPlayer.getActiveTrackIndex();
      const queue = await TrackPlayer.getQueue();
      const activeTrack = typeof activeIndex === 'number' ? queue[activeIndex] : undefined;
      if (activeTrack && typeof activeTrack.url === 'string' && activeTrack.url.startsWith('placeholder://')) {
        console.log('[TrackPlayer] Ignoring placeholder track playback error');
        // Let lazyResolve replace the placeholder later; do not skip or pause.
        return;
      }
    } catch (e) {
      // If inspection fails, proceed with generic error handling.
    }
    
    console.error('[TrackPlayer] 播放错误:', error);
    
    // 【修复】如果当前无网络，暂停播放而不是跳过
    if (netStatus.type === 'none') {
      // 通过 Zustand store 设置全局 UI 错误提示
      usePlayerStore.getState().setPlaybackError('网络已断开，播放暂停');
      await TrackPlayer.pause();
      return;
    }
    
    await TrackPlayer.skipToNext().catch(() => {});
  });
}

/**
 * 在播放列表中直接点击特定分P时，将其作为占位符插入队列并跳转播放
 */
export async function playSpecificPart(bvid: string, cid: number, partTitle: string) {
  // 检查队列中是否已存在该分P
  const currentQueue = await TrackPlayer.getQueue();
  const placeholderUrl = `placeholder://${bvid}-${cid}`;
  const existingIndex = currentQueue.findIndex(t => t.url === placeholderUrl);
  
  if (existingIndex !== -1) {
    // 直接跳转到已存在的轨道
    await TrackPlayer.skip(existingIndex);
    await TrackPlayer.play();
    usePlayerStore.getState().setCurrentCid(cid);
    return;
  }
  
  const rawIdx = await TrackPlayer.getActiveTrackIndex();
  const idx = typeof rawIdx === 'number' ? rawIdx : -1;
  const insertPos = idx >= 0 ? idx + 1 : 0;
  
  // 获取视频信息以构建 track
  const quality = useSettingsStore.getState().quality;
  const info = await audioService.getInfo(bvid, quality, cid);
  
  await TrackPlayer.add({
    id: bvid,
    url: placeholderUrl,
    title: `${info.title} - ${partTitle}`,
    artist: info.author,
    artwork: info.cover,
    duration: info.parts?.find((p: any) => p.cid === cid)?.duration ?? info.duration,
  }, insertPos);
  
  // 跳转到新插入的轨道
  await TrackPlayer.skip(insertPos);
  await TrackPlayer.play();
  
  // 更新 store
  usePlayerStore.getState().setCurrentCid(cid);
}
