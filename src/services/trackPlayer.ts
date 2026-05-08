import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event,
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
import { State } from 'react-native-track-player';
import type { FavoriteVideo } from '../types/domain';
import type { AudioInfo } from '../types/domain';
import { storage } from '../core/storage';
import { useProgressStore } from '../store/progressStore';
import { RateLimitError } from '../core/errors';
import { getCachedUrl, setCachedUrl } from './urlCache';
import { prefetchNextTracks, prefetchFirstTrack } from './dataPrefetcher';
import { upsertVideosBatch, persistVideoPartsToDb } from '../db/operations';

// 用于防止同一索引的 lazyResolve 并发执行，避免重复替换
const resolving = new Set<number>();
// 占位符轨道因 PlaybackError 停止播放后，等待 lazyResolve 完成自动恢复播放的标志位
let _pendingAutoPlayAfterResolve = false;
/** 连续解析失败的歌曲数，用于触发全局熔断 */
let consecutiveTrackFailures = 0;

let _ready = false;
/** 标记新队列加载后是否需要自动播放（由 loadQueue 设置，PlaybackActiveTrackChanged 消费后重置） */
let _pendingPlay = false;

// ========== 滑动窗口预加载引擎（已迁移至 dataPrefetcher.ts）==========
// 【性能优化】预加载已从"操作 TrackPlayer 原生队列"改为"纯数据预取"：
// 1. prefetchNextTracks 只静默获取音频 URL，存入内存缓存 (urlCache)
// 2. lazyResolve 直接从 urlCache 命中，瞬时完成注入
// 3. 完全避免后台对 Bridge 的频繁操作，消除低端机型卡顿
// ========== 滑动窗口预加载引擎结束 ==========

export async function setupPlayer() {
  if (_ready) return;
  try {
    await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      color: 0xFFFB7299, // B站粉色
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
      const tracks = store.queue.map(buildPlaceholderTrack);
      await addTracksBatched(tracks);
      
      const startIndex = Math.max(0, store.queue.findIndex((v) => v.bvid === store.currentBvid));
      await TrackPlayer.skip(startIndex);
      
      const lastPosition = storage.getNumber('lastPlaybackPosition');
      if (lastPosition && lastPosition > 0) {
        await TrackPlayer.seekTo(lastPosition);
      }
      // 【修复D】无论 lastPosition 是否存在，都强制暂停，防止任何自动播放路径
      await TrackPlayer.pause();
      
      // 【修复D】只解析当前轨道，不触发级联（事件处理器不再自动预加载）
      lazyResolve(startIndex, false).catch(() => {});
    }

  } catch (e) {
    LoggerService.error('TrackPlayer', 'setupPlayer', 'setupPlayer error:', e);
  }
  // 【修复D】重置 _pendingPlay，防止从之前的状态泄露
  _pendingPlay = false;
  _ready = true;
}

// buildTrack removed – placeholder logic used in loadQueue

/**
 * 根据 FavoriteVideo 数据构建占位符轨道。
 * 如果视频已有 parts 信息（来自数据库持久化），则注入第一P的 cid 到占位符 URL，
 * 使 lazyResolve 可直接发起 playurl 请求，跳过首次 videoInfo 请求，减少 1 RTT。
 */
function buildPlaceholderTrack(v: FavoriteVideo) {
  const firstCid = v.parts && v.parts.length > 0 ? v.parts[0].cid : undefined;
  return {
    id: v.bvid,
    url: firstCid ? `placeholder://${v.bvid}-${firstCid}` : `placeholder://${v.bvid}`,
    title: v.title,
    artist: v.upper?.name || '未知作者',
    artwork: v.cover,
    duration: v.duration,
    ...(firstCid ? { cid: firstCid } : {}),
  };
}

export async function loadQueue(videos: FavoriteVideo[], startBvid?: string) {
  if (!videos || videos.length === 0) return;
  await TrackPlayer.reset();
  const startIndex = Math.max(0, videos.findIndex((v) => v.bvid === startBvid));

  const tracks = videos.map(buildPlaceholderTrack);
  // 【P1修复】批量添加轨道，避免 Bridge 序列化大量数据导致失败
  await addTracksBatched(tracks);
  // 由调用方在 loadQueue 完成后显式调用 TrackPlayer.play()
  await TrackPlayer.skip(startIndex);
  // 【性能优化】首曲纯数据预取：在 UI 导航动画期间提前获取第一个轨道的音频 URL，
  // 结果存入内存缓存 (urlCache)，lazyResolve 触发时瞬时命中，显著缩短首次播放等待时间
  prefetchFirstTrack(startIndex).catch(() => {});
}

/**
 * Insert a video to be played next after the current track.
 */
export async function insertNext(video: FavoriteVideo): Promise<void> {
  const rawIdx = await TrackPlayer.getActiveTrackIndex();
  const idx = typeof rawIdx === 'number' ? rawIdx : -1;
  const nativeQueue = await TrackPlayer.getQueue();
  const insertPos = idx >= 0 ? idx + 1 : nativeQueue.length;
  await TrackPlayer.add(buildPlaceholderTrack(video), insertPos);
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
/**
 * Flicker-Free Reorder: 以局部替换代替全量 reset + add，避免 PlayerScreen 卸载重建。
 *
 * 核心策略：
 * 1. 从原生队列中移除【除当前播放轨道外】的所有轨道 → 当前轨道保持播放，其索引变为 0
 * 2. 将新队列中位于当前轨道之前的歌曲插入到队首（索引 0 处）
 * 3. 将新队列中位于当前轨道之后的歌曲追加到队尾
 *
 * 效果：useActiveTrack() 始终返回有效值，PlayerScreen 不发生任何卸载/重挂载，零闪烁。
 */
export async function reorderQueue(videos: FavoriteVideo[], startBvid?: string): Promise<void> {
  if (videos.length === 0) return;

  // 1. 保存原生队列中已解析的轨道数据（包含文件 URL、cid 等）
  const nativeQueue = await TrackPlayer.getQueue();
  const nativeTrackMap = new Map<string, any>();
  nativeQueue.forEach(t => nativeTrackMap.set(t.id as string, t));

  // 2. 重新构建轨道列表，优先使用已解析的轨道，回退占位符（含 cid 注入）
  const tracks = videos.map(v => {
    const existing = nativeTrackMap.get(v.bvid);
    if (existing) return existing;
    return buildPlaceholderTrack(v);
  });

  // 3. 获取当前播放状态
  const activeIndex = await TrackPlayer.getActiveTrackIndex();
  const playbackState = await TrackPlayer.getPlaybackState();
  const wasPlaying = playbackState.state === State.Playing;
  const currentBvid = (typeof activeIndex === 'number' && activeIndex >= 0 && nativeQueue[activeIndex])
    ? nativeQueue[activeIndex].id as string
    : (startBvid ?? undefined);

  // 4. 后备方案：无有效当前轨道时回退到安全路径
  if (!currentBvid) {
    await TrackPlayer.reset();
    await TrackPlayer.add(tracks);
    return;
  }

  // 5. Flicker-Free: 保留当前播放轨道，移除其余所有轨道
  //    收集非当前轨道索引，通过批量 remove(indexes[]) 一次性移除。
  //    【性能】O(N) 次桥接调用 → O(1) 次，消除卡顿
  //    【安全】原子操作避免逐条删除时索引偏移导致的 IndexOutOfBounds 异常
  const indicesToRemove: number[] = [];
  nativeQueue.forEach((t, idx) => {
    if (t.id !== currentBvid) {
      indicesToRemove.push(idx);
    }
  });
  if (indicesToRemove.length > 0) {
    await TrackPlayer.remove(indicesToRemove);
  }
  // 此时队列中只剩当前轨道，其索引为 0

  // 6. 在新队列中定位当前轨道
  const currentInNewTracks = tracks.findIndex(t => t.id === currentBvid);
  if (currentInNewTracks === -1) {
    // 当前轨道不在新队列中 → 回退到传统路径
    await TrackPlayer.reset();
    await TrackPlayer.add(tracks);
    return;
  }

  // 7. 分段：当前轨道之前的部分 + 之后的部分
  const beforeTracks = tracks.slice(0, currentInNewTracks);
  const afterTracks = tracks.slice(currentInNewTracks + 1);

  // 8. 局部插入：将 beforeTracks 插入到队首（当前轨道之前），之后的部分追加到队尾
  if (beforeTracks.length > 0) {
    await TrackPlayer.add(beforeTracks, 0);
  }
  if (afterTracks.length > 0) {
    await TrackPlayer.add(afterTracks);
  }

  // 9. 恢复播放状态（TrackPlayer.remove 对非当前轨道不影响播放状态，
  //    但 add 操作后显式调用 play 确保一致性）
  if (wasPlaying) {
    await TrackPlayer.play();
  }
  // 【性能优化】滑动窗口纯数据预取
  const newActiveIndex = await TrackPlayer.getActiveTrackIndex();
  if (typeof newActiveIndex === 'number' && newActiveIndex >= 0) {
    prefetchNextTracks(newActiveIndex).catch(() => {});
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

  // O(1)：批量添加轨道（使用 buildPlaceholderTrack 注入 cid）
  const tracks = videos.map(buildPlaceholderTrack);
  await addTracksBatched(tracks);

  const cur = usePlayerStore.getState();
  const combined = [...cur.queue, ...videos];
  cur.setQueue(combined, startBvid ?? cur.currentBvid ?? undefined);
  // 【性能优化】新轨道加入后，触发滑动窗口纯数据预取，覆盖新追加的轨道
  const activeIndex = await TrackPlayer.getActiveTrackIndex();
  if (typeof activeIndex === 'number' && activeIndex >= 0) {
    prefetchNextTracks(activeIndex).catch(() => {});
  }
}

/**
 * 【P1修复】批量添加轨道到 TrackPlayer，避免一次性添加大量轨道时
 * React Native Bridge 序列化失败的问题。每次最多添加 BATCH_SIZE 个轨道。
 */
const BATCH_SIZE = 15;

async function addTracksBatched(tracks: any[]) {
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    const batch = tracks.slice(i, i + BATCH_SIZE);
    await TrackPlayer.add(batch);
  }
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
    
    let url = '';
    let headers: Record<string, string> | undefined;
    let resolvedInfo: any = undefined;
    
    const cachedPath = await audioCache.has(cacheKey, quality);
    if (cachedPath) {
      url = `file://${cachedPath}`;
    } else {
      // ======== 【性能优化】先查 URL 短期内存缓存 ========
      const cachedUrlEntry = getCachedUrl(bvid, cid);
      if (cachedUrlEntry) {
        // URL 内存缓存命中！跳过 API 请求，直接使用缓存 URL
        url = cachedUrlEntry.url;
        headers = cachedUrlEntry.headers;
        LoggerService.info('TrackPlayer', 'lazyResolve', `URL 缓存命中 (BVID: ${bvid}, CID: ${cid})，跳过 API 解析`);
      } else {
        // ======== 缓存未命中，走完整 API 解析流程 ========
        // 【新增】音频解析重试机制：最多重试 3 次，应对瞬时网络波动或临时限流
        let resolveSuccess = false;
        let lastError: any = null;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            resolvedInfo = await audioService.getInfo(bvid, quality, cid);
            // 【P2修复】流式播放：直接使用 CDN URL + headers，无需等待下载完成
            url = resolvedInfo.audio.baseUrl;
            headers = {
              Referer: config.referer,
              'User-Agent': config.userAgent,
            };
            // ======== 将解析结果存入 URL 内存缓存 ========
            setCachedUrl(bvid, url, headers, cid ?? resolvedInfo.cid);
            // 后台异步下载缓存，供下次离线播放使用
            audioCache.download(cacheKey, quality, resolvedInfo.audio.baseUrl, {
              Referer: config.referer,
              'User-Agent': config.userAgent,
            }).catch(() => {});
            resolveSuccess = true;
            break;
          } catch (error) {
            lastError = error;
            // 【新增】检测到限流立即停止重试，避免触发更严格的风控
            if (error instanceof RateLimitError) {
              LoggerService.warn('TrackPlayer', 'lazyResolve', `检测到 API 限流 (BVID: ${bvid})，停止重试`);
              break;
            }
            LoggerService.warn('TrackPlayer', 'lazyResolve', `第 ${attempt} 次解析音频失败 (BVID: ${bvid}):`, error);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          }
        }
        
        // 【新增】3 次重试均失败，抛出最后一个错误由外层 catch 统一处理
        if (!resolveSuccess) {
          throw lastError || new Error('解析音频失败');
        }
      }
    }

    // 多P视频动态队列展开：仅在根占位符（未指定cid）时执行
    let videoInfo: any;
    if (!cid) {
      videoInfo = resolvedInfo || await audioService.getInfo(bvid, quality);
      const parts = videoInfo?.parts;
      if (parts && parts.length > 1) {
        usePlayerStore.getState().updateVideoParts(bvid, parts);
        usePlayerStore.getState().setCurrentCid(parts[0].cid);
        // 【性能优化】将分P信息持久化到 WatermelonDB 的 extra_json 字段。
        // 下次冷启动时 buildPlaceholderTrack 可直接从 DB 读取 parts 并注入 cid，
        // 使 lazyResolve 跳过首次 videoInfo 请求，减少 1 RTT。
        persistVideoPartsToDb(bvid, parts).catch((err) => {
          LoggerService.warn('TrackPlayer', 'lazyResolve', `持久化分P信息失败 (BVID: ${bvid}):`, err);
        });
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
    // 【修复】放弃平滑替换（add→skip→remove），避免触发 PlaybackActiveTrackChanged 事件级联
    // 改为：根据当前活跃轨道是否为占位符，采用不同策略
    if (isActiveTrack) {
      // 当前播放的就是占位符 → 需要在占位符后插入真实轨道，跳过去，再删除占位符
      // 这虽然会触发一次 PlaybackActiveTrackChanged，但不会产生级联（事件处理器不再自动预加载）
      await TrackPlayer.add(newTrack, actualIndex + 1);
      await TrackPlayer.skip(actualIndex + 1);
      // 也检查 _pendingAutoPlayAfterResolve：PlaybackError 检测到占位符错误时设置的标志
      const shouldPlay = autoPlayActive || _pendingAutoPlayAfterResolve;
      if (_pendingAutoPlayAfterResolve) _pendingAutoPlayAfterResolve = false;
      if (shouldPlay) {
        await TrackPlayer.play();
      }
      await TrackPlayer.remove(actualIndex);
    } else {
      // 当前播放的不是占位符 → 直接移除占位符，再在相同位置插入真实轨道
      // remove + add 不触发 PlaybackActiveTrackChanged，完全无事件级联
      await TrackPlayer.remove(actualIndex);
      await TrackPlayer.add(newTrack, actualIndex);
      // 如果由于时序问题（isActiveTrack 判断时尚未活跃，但 PlaybackError 已为此轨道设置了标志），也尝试恢复
      if (_pendingAutoPlayAfterResolve) {
        _pendingAutoPlayAfterResolve = false;
        await TrackPlayer.play().catch(() => {});
      }
    }
  } catch (error) {
    LoggerService.error('TrackPlayer', 'lazyResolve', `解析音频失败 (BVID: ${bvid}):`, error);
    
    // 检查网络状态，如果是无网导致的失败，停止播放并避免切歌风暴
    if (netStatus.type === 'none' || netStatus.type === 'unknown') {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '无网络连接，停止解析队列');
      await TrackPlayer.pause();
      // 通过 Zustand store 触发全局 UI 错误提示
      usePlayerStore.getState().setPlaybackError('无网络连接，无法加载音频');
      return;
    }

    // 【新增】限流熔断：检测到 RateLimitError，立即停止播放并报错，不重试也不切歌
    if (error instanceof RateLimitError) {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '触发限流熔断，暂停播放');
      await TrackPlayer.pause();
      usePlayerStore.getState().setPlaybackError('B站接口限流，请稍后再试');
      consecutiveTrackFailures = 0;
      return;
    }

    // 【新增】连续失败熔断：连续 3 首歌解析失败则暂停播放，防止无限切歌风暴
    consecutiveTrackFailures++;
    if (consecutiveTrackFailures >= 3) {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '连续 3 首歌解析失败，触发熔断，暂停播放');
      await TrackPlayer.pause();
      usePlayerStore.getState().setPlaybackError('连续多首歌曲加载失败，请检查网络或账号状态');
      consecutiveTrackFailures = 0;
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
      // 【修复B】简化事件处理器：只解析当前轨道，不检查 _pendingPlay/isCurrentlyPlaying
      // 播放/暂停由调用方（loadQueue、playFrom 等）显式控制
      // 不触发自动预加载，彻底切断事件级联链
      await lazyResolve(e.index, false);
      // 【性能优化】当前轨道解析完成后，触发滑动窗口纯数据预取后续轨道
      prefetchNextTracks(e.index).catch(() => {});
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
        LoggerService.info('TrackPlayer', 'PlaybackError', 'Ignoring placeholder track playback error, will auto-resume after resolve');
        // 设置自动恢复标志，等待 lazyResolve 完成后恢复播放
        _pendingAutoPlayAfterResolve = true;
        // 主动触发解析（带 autoPlayActive=true）；若已在解析中则防并发，
        // 由上面的标志位在 lazyResolve 完成时触发自动播放
        if (typeof activeIndex === 'number') {
          lazyResolve(activeIndex, true).catch(() => {
            // 若解析失败，尝试直接调用 play() 恢复
            if (_pendingAutoPlayAfterResolve) {
              _pendingAutoPlayAfterResolve = false;
              TrackPlayer.play().catch(() => {});
            }
          });
        }
        return;
      }
    } catch (e) {
      // If inspection fails, proceed with generic error handling.
    }
    
    LoggerService.error('TrackPlayer', 'PlaybackError', '播放错误:', error);
    
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
