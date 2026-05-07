import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event,
} from 'react-native-track-player';
import { AppState } from 'react-native';
import { audioService } from './audioService';
import { audioCache } from './audioCache';
import { netStatus } from './netStatus';
import { useSettingsStore } from '../store/settingsStore';
import { config } from '../config';
import { usePlayerStore } from '../store/playerStore';
import { performanceMonitor } from './performanceMonitor';
import { State } from 'react-native-track-player';
import type { FavoriteVideo } from '../types/domain';
import { storage } from '../core/storage';
import { useProgressStore } from '../store/progressStore';

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
      notificationCapabilities: [
        Capability.Play, Capability.Pause,
        Capability.SkipToNext, Capability.SkipToPrevious,
      ],
      progressUpdateEventInterval: 1,
    });

    // 监听 AppState 变化，在应用进入后台时保存播放进度
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

    // 冷启动恢复逻辑
    // 等待 Zustand store hydration 完成
    if (!usePlayerStore.persist.hasHydrated()) {
      await new Promise<void>((resolve) => {
        const unsub = usePlayerStore.persist.onFinishHydration(() => {
          unsub();
          resolve();
        });
      });
    }

    const store = usePlayerStore.getState();
    if (store.queue && store.queue.length > 0) {
      const tracks = store.queue.map((v) => ({
        id: v.bvid,
        url: `placeholder://${v.bvid}`,
        title: v.title,
        artist: v.upper.name,
        artwork: v.cover,
        duration: v.duration,
      }));
      await TrackPlayer.add(tracks);
      
      const startIndex = Math.max(0, store.queue.findIndex((v) => v.bvid === store.currentBvid));
      await TrackPlayer.skip(startIndex);
      
      const lastPosition = storage.getNumber('lastPlaybackPosition');
      if (lastPosition && lastPosition > 0) {
        // 恢复上一次播放进度后保持暂停，防止自动播放
        await TrackPlayer.seekTo(lastPosition);
        await TrackPlayer.pause();
      }
      
      // 触发当前轨道的解析，冷启动时不自动播放
      lazyResolve(startIndex, false).catch(() => {});
    }

  } catch (e) {
    console.error('[TrackPlayer] setupPlayer error:', e);
  }
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
    lazyResolve(startIndex + 1, false).catch(() => {});
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
 *
 * 性能优化：使用 reset() + 批量 add() 替代逐个 move() 调用，
 * 将 Bridge 调用次数从 O(N) 降至 O(1)，避免长列表卡顿。
 */
export async function reorderQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  if (videos.length === 0) return;

  // 1. 保存原生队列中已解析的轨道数据（包含文件 URL、cid 等）
  const nativeQueue = await TrackPlayer.getQueue();
  const nativeTrackMap = new Map<string, any>();
  nativeQueue.forEach(t => nativeTrackMap.set(t.id as string, t));

  // 2. 重新构建轨道列表，优先使用已解析的轨道，回退占位符
  const tracks = videos.map(v => {
    const existing = nativeTrackMap.get(v.bvid);
    if (existing) return existing;
    return {
      id: v.bvid,
      url: `placeholder://${v.bvid}`,
      title: v.title,
      artist: v.upper.name,
      artwork: v.cover,
      duration: v.duration,
    };
  });

  // 3. 保存当前播放状态
  const activeIndex = await TrackPlayer.getActiveTrackIndex();
  const playbackState = await TrackPlayer.getPlaybackState();
  const wasPlaying = playbackState.state === State.Playing;
  const currentBvid = (typeof activeIndex === 'number' && activeIndex >= 0 && nativeQueue[activeIndex])
    ? nativeQueue[activeIndex].id as string
    : (startBvid ?? undefined);

  // 4. O(1)：reset 清空 + 批量添加全部轨道
  await TrackPlayer.reset();
  await TrackPlayer.add(tracks);

  // 5. 恢复播放位置
  if (currentBvid) {
    const skipIdx = tracks.findIndex(t => t.id === currentBvid);
    if (skipIdx >= 0) {
      await TrackPlayer.skip(skipIdx);
      if (wasPlaying) {
        await TrackPlayer.play();
      }
    }
  }
}

/**
 * Append a batch of videos to the end of the queue.
 *
 * 性能优化：使用单次批量 add() 替代循环逐个 add()，
 * 将 Bridge 调用次数从 O(N) 降至 O(1)。
 */
export async function appendQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  if (videos.length === 0) return;

  // O(1)：批量添加轨道
  const tracks = videos.map(v => ({
    id: v.bvid,
    url: `placeholder://${v.bvid}`,
    title: v.title,
    artist: v.upper.name,
    artwork: v.cover,
    duration: v.duration,
  }));
  await TrackPlayer.add(tracks);

  const cur = usePlayerStore.getState();
  const combined = [...cur.queue, ...videos];
  cur.setQueue(combined, startBvid ?? cur.currentBvid ?? undefined);
}

async function lazyResolve(index: number, autoPlayActive: boolean = true) {
  // 防止同一索引并发解析导致重复替换
  if (resolving.has(index)) return;
  resolving.add(index);
  let bvid = '';
  let isActiveTrack = false;
  try {
    const activeIdx = await TrackPlayer.getActiveTrackIndex();
    if (activeIdx === index) {
      isActiveTrack = true;
      usePlayerStore.getState().setResolving(true);
    }
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
        // 仅当用户开启"将分P列表加入播放列表"时才展开后续分P
        if (useSettingsStore.getState().expandMultiPart) {
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
    }

    // 动态查找当前 placeholder 的实际索引，防止队列变化导致 index 失效
    const freshQueue = await TrackPlayer.getQueue();
    const actualIndex = freshQueue.findIndex(tr => tr.id === bvid && String(tr.url).startsWith('placeholder://'));
    if (actualIndex === -1) {
      return; // 找不到对应的 placeholder，可能已被用户操作移出队列或已解析
    }

    // 如果是多P视频的根占位符，替换为第一P的标题
    let effectiveCid = cid;
    let title = t.title;
    if (!cid && videoInfo?.parts && videoInfo.parts.length > 0) {
      effectiveCid = videoInfo.parts[0].cid;
      title = `${videoInfo.title} - ${videoInfo.parts[0].title}`;
    }
    const newTrack: any = { ...t, url, title, userAgent: config.userAgent, headers, cid: effectiveCid };
    // 平滑替换策略：先在 actualIndex 后面插入新 track，跳过去，再删掉原来的 placeholder
    await TrackPlayer.add(newTrack, actualIndex + 1);
    const postAddActiveTrackIndex = await TrackPlayer.getActiveTrackIndex();
    if (postAddActiveTrackIndex !== undefined && postAddActiveTrackIndex === actualIndex) {
      await TrackPlayer.skip(actualIndex + 1);
      if (autoPlayActive) {
        await TrackPlayer.play(); // 确保播放恢复
      }
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
    if (isActiveTrack) {
      usePlayerStore.getState().setResolving(false);
    }
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
    
    // 保存播放进度
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
    // Record start of track loading/playback
    const activeTrack = await TrackPlayer.getActiveTrack();
    if (activeTrack?.id) {
      const bvid = activeTrack.id as string;
      performanceMonitor.start(bvid);
      // 同步当前播放的 bvid 到 store，修复 UI 高亮不同步问题
      usePlayerStore.getState().setCurrentBvid(bvid);
      // 提取当前播放轨道的 cid，更新到 store
      // 优先从 track 对象的 cid 属性读取（已解析的轨道在 lazyResolve 中设置）
      const trackCid = (activeTrack as any).cid;
      if (typeof trackCid === 'number') {
        usePlayerStore.getState().setCurrentCid(trackCid);
      } else if (activeTrack.url && typeof activeTrack.url === 'string') {
        // 回退：从 placeholder URL 中解析 cid
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
        } else {
          // 已解析但无 cid 的单P视频，清空 currentCid
          usePlayerStore.getState().setCurrentCid(null);
        }
      }
    }
    if (e.index !== undefined) {
      await lazyResolve(e.index, false);
      // prefetch next track if exists for seamless playback
      try {
        const queue = await TrackPlayer.getQueue();
        if (e.index + 1 < queue.length) {
          lazyResolve(e.index + 1, false).catch(() => {});
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
 * 在播放列表中直接点击特定分P时：
 * - 展开模式：查找队列中已存在的分P轨道（按 id + cid 匹配）并跳转；若无则插入
 * - 不展开模式：替换当前播放轨道，保持队列结构不变
 */
export async function playSpecificPart(bvid: string, cid: number, partTitle: string) {
  const expandMultiPart = useSettingsStore.getState().expandMultiPart;
  const currentQueue = await TrackPlayer.getQueue();
  const placeholderUrl = `placeholder://${bvid}-${cid}`;
  const quality = useSettingsStore.getState().quality;
  
  if (expandMultiPart) {
    // 展开模式：查找队列中已存在的分P轨道（按 id 和 cid 匹配）
    // 兼容未解析的 placeholder 和已解析的 file:// 轨道
    const existingIndex = currentQueue.findIndex(
      t => t.id === bvid && ((t as any).cid === cid || t.url === placeholderUrl)
    );
    
    if (existingIndex !== -1) {
      await TrackPlayer.skip(existingIndex);
      await TrackPlayer.play();
      usePlayerStore.getState().setCurrentCid(cid);
      return;
    }
    
    // 队列中不存在该分P，在当前位置后插入
    const rawIdx = await TrackPlayer.getActiveTrackIndex();
    const idx = typeof rawIdx === 'number' ? rawIdx : -1;
    const insertPos = idx >= 0 ? idx + 1 : 0;
    
    const info = await audioService.getInfo(bvid, quality, cid);
    
    await TrackPlayer.add({
      id: bvid,
      url: placeholderUrl,
      title: `${info.title} - ${partTitle}`,
      artist: info.author,
      artwork: info.cover,
      duration: info.parts?.find((p: any) => p.cid === cid)?.duration ?? info.duration,
      cid,
    }, insertPos);
    
    await TrackPlayer.skip(insertPos);
    await TrackPlayer.play();
    usePlayerStore.getState().setCurrentCid(cid);
  } else {
    // 不展开模式：替换当前播放轨道
    const rawIdx = await TrackPlayer.getActiveTrackIndex();
    const idx = typeof rawIdx === 'number' ? rawIdx : -1;
    if (idx === -1) {
      // 没有当前轨道，直接插入
      const info = await audioService.getInfo(bvid, quality, cid);
      await TrackPlayer.add({
        id: bvid,
        url: placeholderUrl,
        title: `${info.title} - ${partTitle}`,
        artist: info.author,
        artwork: info.cover,
        duration: info.parts?.find((p: any) => p.cid === cid)?.duration ?? info.duration,
        cid,
      }, 0);
      await TrackPlayer.skip(0);
      await TrackPlayer.play();
    } else {
      // 在 idx + 1 处插入新分P，跳转后删除原 idx 处的轨道
      const info = await audioService.getInfo(bvid, quality, cid);
      await TrackPlayer.add({
        id: bvid,
        url: placeholderUrl,
        title: `${info.title} - ${partTitle}`,
        artist: info.author,
        artwork: info.cover,
        duration: info.parts?.find((p: any) => p.cid === cid)?.duration ?? info.duration,
        cid,
      }, idx + 1);
      await TrackPlayer.skip(idx + 1);
      await TrackPlayer.play();
      await TrackPlayer.remove(idx);
    }
    usePlayerStore.getState().setCurrentCid(cid);
  }
}
