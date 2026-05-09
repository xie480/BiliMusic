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
/** 占位符轨道因 PlaybackError 停止播放后，等待 lazyResolve 完成后恢复播放的标志。
 *  由 PlaybackError 处理器设置，lazyResolve 完成时消费并重置。
 *  不作为 autoPlay 参数传递，而是 lazyResolve 内部 shouldResumePlay 判定的一项输入。 */
let _pendingAutoPlayAfterResolve = false;
/** 连续解析失败的歌曲数，用于触发全局熔断 */
let consecutiveTrackFailures = 0;

/** 队列版本号：每次 loadQueue / setupPlayer 单调递增。
 *  所有异步回调（事件处理器、lazyResolve、预取）携带此版本号，
 *  一旦版本不匹配立即中止，从根本上消除陈旧事件竞态。 */
let _queueVersion = 0;

/** 队列是否已完成本次加载并稳定。
 *  - false：正在 addTracksBatched / skip 等操作中（事件过滤用）
 *  - true：队列结构已稳定，允许事件处理器进入版本校验阶段 */
let _queueStable = false;

let _ready = false;

/**
 * 统一版本门禁：所有涉及队列操作的异步路径在关键节点调用此函数。
 * 只要返回 false，调用方必须立即中止，不得继续操作 TrackPlayer。
 *
 * @param version  调用方携带的版本号
 * @param label    日志标签（用于问题定位）
 * @returns        版本是否仍然有效
 */
function guardVersion(version: number, label: string): boolean {
  if (version !== 0 && version !== _queueVersion) {
    LoggerService.info(
      'TrackPlayer',
      'guardVersion',
      `[${label}] 版本失效 (调用版本:${version} ≠ 当前版本:${_queueVersion})，中止操作`
    );
    return false;
  }
  return true;
}

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
      // 【冷启动静默恢复】
      // 1. 构建队列 + 定位到历史音频位置
      // 2. 静默解析目标轨道（仅填充 URL，不播放）
      // 3. 恢复进度
      // 4. 保持暂停
      // 全程不触发任何首位音频的预加载或自动播放

      const version = ++_queueVersion;
      _queueStable = false;
      _pendingAutoPlayAfterResolve = false;

      try {
        const tracks = store.queue.map(buildPlaceholderTrack);
        await addTracksBatched(tracks);

        const startIndex = Math.max(0, store.queue.findIndex((v) => v.bvid === store.currentBvid));
        await TrackPlayer.skip(startIndex);

        _queueStable = true;

        // 静默恢复进度
        const lastPosition = storage.getNumber('lastPlaybackPosition');
        if (lastPosition && lastPosition > 0) {
          await TrackPlayer.seekTo(lastPosition);
        }

        // 静默解析目标轨道（不播放）
        await resolveCurrentTrack(version);

        // 最终保险：强制执行暂停
        await TrackPlayer.pause();
      } finally {
        _queueStable = true;
      }
    }

  } catch (e) {
    LoggerService.error('TrackPlayer', 'setupPlayer', 'setupPlayer error:', e);
  }
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

/**
 * 构建播放队列并跳转到目标轨道。
 *
 * 职责边界：
 * - 仅负责：reset → addTracksBatched → skip(startIndex) → 预取首曲数据
 * - 不负责：解析任何轨道（lazyResolve 由调用方或事件处理器显式触发）
 * - 不负责：播放或暂停（播放状态由调用方控制）
 *
 * 返回队列版本号，供调用方在后续操作中携带。
 */
export async function loadQueue(
  videos: FavoriteVideo[],
  startBvid?: string,
): Promise<number> {
  if (!videos || videos.length === 0) return _queueVersion;

  // 递增版本号：宣告新队列时代的开始
  const version = ++_queueVersion;
  _queueStable = false;
  // 清空残留的自动播放标志（上一代遗留）
  _pendingAutoPlayAfterResolve = false;

  try {
    await TrackPlayer.reset();

    const startIndex = Math.max(
      0,
      startBvid ? videos.findIndex((v) => v.bvid === startBvid) : 0,
    );

    // 【P0修复】先只添加目标轨道的占位符到空队列，原生层仅准备1个轨道
    // 避免一次性 add 所有轨道时原生层同步准备索引 0 的占位符导致阻塞
    const targetPlaceholder = buildPlaceholderTrack(videos[startIndex]);
    await TrackPlayer.add(targetPlaceholder);
    // 此时队列只有 1 个轨道（目标轨道），活跃索引 = 0

    // 【v3修复】beforeTarget 必须插入到索引 0（目标轨道之前），而非追加到队尾
    // 确保队列最终顺序与原始列表完全一致：[beforeTarget..., target, afterTarget...]
    const beforeTarget = videos.slice(0, startIndex);
    const afterTarget = videos.slice(startIndex + 1);

    if (beforeTarget.length > 0) {
      // 插入到索引 0：这些轨道将出现在目标轨道之前
      await addTracksBatched(beforeTarget.map(buildPlaceholderTrack), 0);
    }
    if (afterTarget.length > 0) {
      // 追加到队尾：这些轨道将出现在目标轨道之后
      await addTracksBatched(afterTarget.map(buildPlaceholderTrack));
    }

    // beforeTarget 全部插入到索引 0 后，目标轨道被推到位置 beforeTarget.length
    const finalTargetIndex = beforeTarget.length;
    await TrackPlayer.skip(finalTargetIndex);

    // 首曲纯数据预取：提前获取音频 URL 存入内存缓存
    prefetchFirstTrack(finalTargetIndex).catch(() => {});

    return version;
  } finally {
    // 标记队列稳定，允许事件处理器进入版本校验阶段
    _queueStable = true;
    // 版本号已递增，后续到达的旧版本事件全部被 guardVersion 拦截
  }
}

/**
 * 解析当前活跃轨道（静默，默认不播放）。
 *
 * 与 loadQueue 解耦：此函数由调用方在适当时机显式调用。
 *
 * 使用场景：
 * - 冷启动恢复：loadQueue → resolveCurrentTrack(version) → pause
 * - VideosScreen::playFrom：loadQueue → play → 事件驱动 lazyResolve
 * - PlaybackError 恢复：由事件处理器标记 _pendingAutoPlayAfterResolve → 触发 lazyResolve
 *
 * @param version  调用方持有的队列版本号
 */
export async function resolveCurrentTrack(version: number): Promise<void> {
  if (!guardVersion(version, 'resolveCurrentTrack')) return;

  try {
    const index = await TrackPlayer.getActiveTrackIndex();
    if (typeof index !== 'number' || index < 0) return;

    // 二次版本校验：getActiveTrackIndex 是 Bridge 调用，版本可能已变
    if (!guardVersion(version, 'resolveCurrentTrack:postBridge')) return;

    await lazyResolve(index, { version });
  } catch (e) {
    LoggerService.error('TrackPlayer', 'resolveCurrentTrack', '静默解析失败:', e);
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

  // 9. 恢复播放状态
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

/**
 * 批量添加轨道，支持指定插入索引。
 *
 * 当 insertIndex 为 number 时，由于 TrackPlayer.add(batch, index)
 * 是将 batch 整体插入到 index 之前，后续插入的 batch 会出现在更前面，
 * 因此必须按**逆序**分批处理，以保证最终队列顺序与原始数组一致。
 *
 * 示例：BATCH_SIZE=15, tracks=[s0..s19], insertIndex=0, 队列原本=[target]
 *   逆序分批插入：
 *     ① 插入 [s15..s19] at 0 → [s15..s19, target]
 *     ② 插入 [s0..s14]  at 0 → [s0..s14, s15..s19, target] ✓
 */
async function addTracksBatched(tracks: any[], insertIndex?: number) {
  if (typeof insertIndex === 'number') {
    const totalBatches = Math.ceil(tracks.length / BATCH_SIZE);
    for (let batchIdx = totalBatches - 1; batchIdx >= 0; batchIdx--) {
      const start = batchIdx * BATCH_SIZE;
      const batch = tracks.slice(start, start + BATCH_SIZE);
      await TrackPlayer.add(batch, insertIndex);
    }
  } else {
    for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
      const batch = tracks.slice(i, i + BATCH_SIZE);
      await TrackPlayer.add(batch);
    }
  }
}

/**
 * 选项对象（替代 bool 参数，语义更明确）
 */
interface LazyResolveOptions {
  /** 调用方持有的队列版本号 */
  version: number;
  /** 是否在解析完成后自动播放。
   *  仅在极少数场景（PlaybackError 恢复）可能为 true，
   *  绝大多数路径必须传 false。缺席时默认 false。 */
  autoPlay?: boolean;
}

/**
 * 解析指定索引的占位符轨道为真实音频 URL。
 *
 * 调用约定（硬规则）：
 * - autoPlay 缺席或 false：静默解析，完成后保持当前播放/暂停状态
 * - autoPlay 为 true：仅限 PlaybackError 恢复路径经 _pendingAutoPlayAfterResolve 间接达成
 * - 严禁任何调用方在非恢复场景传入 autoPlay=true
 *
 * 三重版本校验：
 * ① 入口立即校验（同步，零开销）
 * ② 每次 Bridge await 返回后校验（getActiveTrackIndex / getQueue / add / skip）
 * ③ 替换占位符前最终校验
 */
async function lazyResolve(
  index: number,
  options: LazyResolveOptions,
): Promise<void> {
  const { version, autoPlay = false } = options;

  // ======== 第一重：入口版本校验 ========
  if (!guardVersion(version, `lazyResolve:entry(idx=${index})`)) return;

  // 防止同一索引并发解析
  if (resolving.has(index)) return;
  resolving.add(index);

  let bvid = '';
  let isActiveTrack = false;
  try {
    // ======== Bridge 调用 1 ========
    const activeIdx = await TrackPlayer.getActiveTrackIndex();
    if (activeIdx !== index) {
      // 活跃轨道已变更，本任务是过期的
      return;
    }
    // ======== 第二重：Bridge 返回后版本校验 ========
    if (!guardVersion(version, `lazyResolve:postActiveIdx(idx=${index})`)) return;

    isActiveTrack = true;
    usePlayerStore.getState().setResolving(true);

    // ======== Bridge 调用 2 ========
    const queue = await TrackPlayer.getQueue();
    if (!guardVersion(version, `lazyResolve:postGetQueue(idx=${index})`)) return;

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
      const cachedUrlEntry = getCachedUrl(bvid, cid);
      if (cachedUrlEntry) {
        url = cachedUrlEntry.url;
        headers = cachedUrlEntry.headers;
        LoggerService.info('TrackPlayer', 'lazyResolve', `URL 缓存命中 (BVID: ${bvid}, CID: ${cid})，跳过 API 解析`);
      } else {
        let resolveSuccess = false;
        let lastError: any = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            resolvedInfo = await audioService.getInfo(bvid, quality, cid);
            url = resolvedInfo.audio.baseUrl;
            headers = {
              Referer: config.referer,
              'User-Agent': config.userAgent,
            };
            setCachedUrl(bvid, url, headers, cid ?? resolvedInfo.cid);
            audioCache.download(cacheKey, quality, resolvedInfo.audio.baseUrl, {
              Referer: config.referer,
              'User-Agent': config.userAgent,
            }).catch(() => {});
            resolveSuccess = true;
            break;
          } catch (error) {
            lastError = error;
            if (error instanceof RateLimitError) {
              LoggerService.warn('TrackPlayer', 'lazyResolve', `检测到 API 限流 (BVID: ${bvid})，停止重试`);
              break;
            }
            LoggerService.warn('TrackPlayer', 'lazyResolve', `第 ${attempt} 次解析音频失败 (BVID: ${bvid}):`, error);
            if (attempt < 3) await new Promise(r => setTimeout(r, 500));
          }
        }

        if (!resolveSuccess) {
          throw lastError || new Error('解析音频失败');
        }
      }
    }

    // ======== URL 解析后版本校验 ========
    if (!guardVersion(version, `lazyResolve:postResolve(idx=${index},bvid=${bvid})`)) return;

    // 异步解析完成后二次校验：确保当前活跃轨道仍然是目标轨道
    const currentActiveIdx = await TrackPlayer.getActiveTrackIndex();
    if (currentActiveIdx !== index) {
      LoggerService.info('TrackPlayer', 'lazyResolve', `解析完成但活跃轨道已变更 (期望:${index} 实际:${currentActiveIdx})，放弃本次替换`);
      return;
    }
    if (!guardVersion(version, `lazyResolve:postActiveIdx2(idx=${index})`)) return;

    // 多P视频动态队列展开：仅在根占位符（未指定cid）时执行
    let videoInfo: any;
    if (!cid) {
      videoInfo = resolvedInfo || await audioService.getInfo(bvid, quality);
      const parts = videoInfo?.parts;
      if (parts && parts.length > 1) {
        usePlayerStore.getState().updateVideoParts(bvid, parts);
        usePlayerStore.getState().setCurrentCid(parts[0].cid);
        persistVideoPartsToDb(bvid, parts).catch((err) => {
          LoggerService.warn('TrackPlayer', 'lazyResolve', `持久化分P信息失败 (BVID: ${bvid}):`, err);
        });
        if (useSettingsStore.getState().expandMultiPart) {
          const expandQueue = await TrackPlayer.getQueue();
          const currentIdx = expandQueue.findIndex(
            tr => tr.id === bvid && String(tr.url).startsWith('placeholder://')
          );
          if (currentIdx !== -1) {
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
    if (!guardVersion(version, `lazyResolve:postFreshQueue(idx=${index})`)) return;

    const actualIndex = freshQueue.findIndex(tr => tr.id === bvid && String(tr.url).startsWith('placeholder://'));
    if (actualIndex === -1) {
      return;
    }

    // 如果是多P视频的根占位符，替换为第一P的标题
    let effectiveCid = cid;
    let title = t.title;
    if (!cid && videoInfo?.parts && videoInfo.parts.length > 0) {
      effectiveCid = videoInfo.parts[0].cid;
      title = `${videoInfo.title} - ${videoInfo.parts[0].title}`;
    }
    const newTrack: any = { ...t, url, title, userAgent: config.userAgent, headers, cid: effectiveCid };

    // ======== 第三重：替换前最终版本校验 ========
    if (!guardVersion(version, `lazyResolve:preReplace(idx=${index})`)) return;

    if (isActiveTrack) {
      await TrackPlayer.add(newTrack, actualIndex + 1);

      // 记录 skip 前的播放状态
      const playbackState = await TrackPlayer.getPlaybackState();
      const isPlaying = playbackState.state === State.Playing || playbackState.state === State.Buffering;

      await TrackPlayer.skip(actualIndex + 1);

      // ======== 统一播放决策 ========
      // 三条规则按优先级：
      // 1. _pendingAutoPlayAfterResolve（PlaybackError 恢复标志）→ 需恢复播放
      // 2. autoPlay（仅 PlaybackError 路径通过标志间接达成，此处为防御性检查）
      // 3. skip 前正在播放 → 恢复播放（用户主动操作中）
      // 其他情况：保持暂停
      const shouldResumePlay =
        _pendingAutoPlayAfterResolve || autoPlay || isPlaying;

      // 消费恢复标志
      if (_pendingAutoPlayAfterResolve) {
        _pendingAutoPlayAfterResolve = false;
      }

      if (shouldResumePlay) {
        await TrackPlayer.play();
      } else {
        await TrackPlayer.pause();
      }
      await TrackPlayer.remove(actualIndex);
    } else {
      // 非活跃轨道 → 直接替换（remove + add），不触发事件级联
      await TrackPlayer.remove(actualIndex);
      await TrackPlayer.add(newTrack, actualIndex);
      // PlaybackError 恢复逻辑
      if (_pendingAutoPlayAfterResolve) {
        _pendingAutoPlayAfterResolve = false;
        await TrackPlayer.play().catch(() => {});
      }
    }
  } catch (error) {
    LoggerService.error('TrackPlayer', 'lazyResolve', `解析音频失败 (BVID: ${bvid}):`, error);

    if (netStatus.type === 'none' || netStatus.type === 'unknown') {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '无网络连接，停止解析队列');
      await TrackPlayer.pause();
      usePlayerStore.getState().setPlaybackError('无网络连接，无法加载音频');
      return;
    }

    if (error instanceof RateLimitError) {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '触发限流熔断，暂停播放');
      await TrackPlayer.pause();
      usePlayerStore.getState().setPlaybackError('B站接口限流，请稍后再试');
      consecutiveTrackFailures = 0;
      return;
    }

    consecutiveTrackFailures++;
    if (consecutiveTrackFailures >= 3) {
      LoggerService.warn('TrackPlayer', 'lazyResolve', '连续 3 首歌解析失败，触发熔断，暂停播放');
      await TrackPlayer.pause();
      usePlayerStore.getState().setPlaybackError('连续多首歌曲加载失败，请检查网络或账号状态');
      consecutiveTrackFailures = 0;
      return;
    }

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
  // 【修复二】锁屏/通知栏切歌时同步触发播放，暂停状态下切歌自动恢复播放
  TrackPlayer.addEventListener(Event.RemoteNext, async () => {
    await TrackPlayer.skipToNext();
    await TrackPlayer.play();
  });
  TrackPlayer.addEventListener(Event.RemotePrevious, async () => {
    await TrackPlayer.skipToPrevious();
    await TrackPlayer.play();
  });
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

  /**
   * 【关键修复 v2】PlaybackActiveTrackChanged 事件处理器
   *
   * 陈旧事件快速退出策略：
   * 1. 通过 getActiveTrackIndex() 获取原生层当前的**实际活跃索引**
   * 2. 若 e.index（事件报告的索引）与 actualIndex 不一致 → 陈旧事件
   *    → 仅同步 currentBvid 状态，跳过 lazyResolve（避免无效 Bridge 往返）
   * 3. 所有后续操作使用 actualIndex 而非 e.index，确保操作对象为当前真实活跃轨道
   *
   * 为什么这比仅靠 _queueStable + _queueVersion 更可靠：
   * - 同一版本周期内，原生层批量 add 产生的事件可能延迟到 _queueStable=true 后才到达
   * - 这些陈旧事件携带的 e.index 指向已过时的索引（如 0），而非当前活跃索引
   * - 直接比对 e.index 与 actualIndex 是最简练、最精确的陈旧检测
   */
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (e) => {
    if (e.index === undefined) return;

    // ======== 门禁 1：队列是否已稳定 ========
    if (!_queueStable) {
      LoggerService.info(
        'TrackPlayer',
        'PlaybackActiveTrackChanged',
        `队列未稳定，屏蔽事件 (index:${e.index})`,
      );
      return;
    }

    // ======== 门禁 2：捕获当前版本号 ========
    const capturedVersion = _queueVersion;
    if (capturedVersion === 0) return;

    // ======== 门禁 3：获取当前活跃轨道 ========
    const activeTrack = await TrackPlayer.getActiveTrack();
    if (!guardVersion(capturedVersion, `PlaybackActiveTrackChanged(idx=${e.index})`)) return;

    if (!activeTrack?.id) return;

    // ======== 【v2新增】快速陈旧事件检测：比对事件索引与实际活跃索引 ========
    const actualIndex = await TrackPlayer.getActiveTrackIndex();
    if (!guardVersion(capturedVersion, 'PlaybackActiveTrackChanged:postActualIndex')) return;

    if (e.index !== actualIndex) {
      LoggerService.info(
        'TrackPlayer',
        'PlaybackActiveTrackChanged',
        `陈旧事件 (事件索引:${e.index} ≠ 实际活跃索引:${actualIndex})，仅同步状态后退出`,
      );
      // 仅同步 currentBvid / currentCid 状态，不触发 lazyResolve
      usePlayerStore.getState().setCurrentBvid(activeTrack.id as string);
      const trackCid = (activeTrack as any).cid;
      if (typeof trackCid === 'number') {
        usePlayerStore.getState().setCurrentCid(trackCid);
      } else {
        usePlayerStore.getState().setCurrentCid(null);
      }
      return;
    }

    // ======== 路径 A：轨道已解析 → 仅同步状态 + 预取 ========
    if (activeTrack.url && !String(activeTrack.url).startsWith('placeholder://')) {
      const bvid = activeTrack.id as string;
      performanceMonitor.start(bvid);
      usePlayerStore.getState().setCurrentBvid(bvid);

      const trackCid = (activeTrack as any).cid;
      if (typeof trackCid === 'number') {
        usePlayerStore.getState().setCurrentCid(trackCid);
      } else {
        usePlayerStore.getState().setCurrentCid(null);
      }

      prefetchNextTracks(actualIndex).catch(() => {});
      if (e.lastTrack?.id) autoCache(e.lastTrack.id as string);
      return;
    }

    // ======== 路径 B：轨道是占位符 → 静默解析（不自动播放） ========
    const bvid = activeTrack.id as string;
    performanceMonitor.start(bvid);
    usePlayerStore.getState().setCurrentBvid(bvid);

    const trackCid = (activeTrack as any).cid;
    if (typeof trackCid === 'number') {
      usePlayerStore.getState().setCurrentCid(trackCid);
    } else if (activeTrack.url && typeof activeTrack.url === 'string') {
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
        usePlayerStore.getState().setCurrentCid(null);
      }
    }

    // 使用实际活跃索引（而非 e.index）调用 lazyResolve
    await lazyResolve(actualIndex, { version: capturedVersion });

    prefetchNextTracks(actualIndex).catch(() => {});
    if (e.lastTrack?.id) autoCache(e.lastTrack.id as string);
  });

  // ========== PlaybackError 事件处理器 ==========
  TrackPlayer.addEventListener(Event.PlaybackError, async (error) => {
    // ======== 门禁 1：队列是否已稳定 ========
    if (!_queueStable) {
      LoggerService.info(
        'TrackPlayer',
        'PlaybackError',
        '队列未稳定，忽略播放错误',
      );
      return;
    }

    // ======== 门禁 2：捕获当前版本号 ========
    const capturedVersion = _queueVersion;
    if (capturedVersion === 0) return;

    // ======== 核心逻辑：判断错误是否来自占位符轨道 ========
    try {
      const activeTrack = await TrackPlayer.getActiveTrack();
      if (!guardVersion(capturedVersion, 'PlaybackError:postActiveTrack')) return;

      if (
        activeTrack &&
        typeof activeTrack.url === 'string' &&
        activeTrack.url.startsWith('placeholder://')
      ) {
        LoggerService.info(
          'TrackPlayer',
          'PlaybackError',
          '检测到占位符轨道播放错误，触发补解析',
        );

        // 仅设置恢复标志，不传递 autoPlay=true
        // 真正是否播放由 lazyResolve 内部的 shouldResumePlay 三段判定决定
        _pendingAutoPlayAfterResolve = true;

        const activeIndex = await TrackPlayer.getActiveTrackIndex();
        if (!guardVersion(capturedVersion, 'PlaybackError:postActiveIndex')) return;

        if (typeof activeIndex === 'number' && activeIndex >= 0) {
          // 【v2新增】二次确认：activeTrack 的 id 与 activeIndex 位置的轨道 id 一致
          const queue = await TrackPlayer.getQueue();
          if (!guardVersion(capturedVersion, 'PlaybackError:postGetQueue')) return;

          const trackAtIndex = queue[activeIndex];
          if (!trackAtIndex || trackAtIndex.id !== activeTrack.id) {
            LoggerService.info(
              'TrackPlayer',
              'PlaybackError',
              `索引不一致 (activeTrack.id=${activeTrack.id}, queue[${activeIndex}].id=${trackAtIndex?.id})，放弃补解析`,
            );
            return;
          }

          // autoPlay 缺省 = false，由 _pendingAutoPlayAfterResolve 标志驱动恢复播放
          lazyResolve(activeIndex, { version: capturedVersion }).catch(() => {
            // 解析失败时的兜底：尝试直接恢复播放
            if (_pendingAutoPlayAfterResolve) {
              _pendingAutoPlayAfterResolve = false;
              TrackPlayer.play().catch(() => {});
            }
          });
        }
        return;
      }
    } catch (e) {
      // 检查失败，走通用错误处理
    }

    // ======== 通用错误处理路径 ========
    LoggerService.error('TrackPlayer', 'PlaybackError', '播放错误:', error);

    if (netStatus.type === 'none') {
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
