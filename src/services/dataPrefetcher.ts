/**
 * 纯数据预取模块 (Data Prefetcher)
 *
 * 核心思路：将"预加载"与"播放器注入"彻底解耦。
 *
 * 原来的 preloadNext / preloadResolve 会直接操作 TrackPlayer 的原生队列，
 * 在低端机型上可能因频繁 Bridge 通信导致 UI 卡顿。
 *
 * 优化后：
 * 1. 预加载仅在后台静默调用 audioService.getInfo 获取音频真实 URL
 * 2. 获取到的 URL 存入 URL 短期内存缓存 (urlCache)
 * 3. 当用户真正切歌时，lazyResolve 直接从内存缓存命中，瞬时完成注入
 *
 * 这样既保证了预加载的效果，又完全避免了后台无意义的原生队列操作。
 */

import TrackPlayer from 'react-native-track-player';
import { InteractionManager } from 'react-native';
import LoggerService from './LoggerService';
import { audioService } from './audioService';
import { useSettingsStore } from '../store/settingsStore';
import { netStatus } from './netStatus';
import { TaskQueue } from '../utils/taskQueue';
import { setCachedUrl } from './urlCache';

/** 全局预解析任务队列，并发度为 2 */
const prefetchQueue = new TaskQueue(2);

/** 滑动窗口大小：根据网络状态动态调整 */
function getWindowSize(): number {
  if (netStatus.type === 'wifi') return 3;
  if (netStatus.type === 'cellular') return 1;
  return 0; // 无网络不预加载
}

/**
 * 纯数据预取：静默获取指定索引轨道的音频 URL，存入内存缓存。
 * 不操作 TrackPlayer 队列，完全无副作用。
 */
async function prefetchResolve(index: number): Promise<void> {
  try {
    const queue = await TrackPlayer.getQueue();
    const t = queue[index];
    if (!t) return;

    // 仅对占位符轨道（未解析）执行预取
    const urlStr = String(t.url || '');
    if (!urlStr.startsWith('placeholder://')) return;

    const rawId = urlStr.replace('placeholder://', '');
    const [bvid, cidStr] = rawId.split('-');
    const cid = cidStr ? parseInt(cidStr, 10) : undefined;

    if (!bvid) return;

    const quality = useSettingsStore.getState().quality;

    // 静默调用 getInfo（内部有 24h 缓存，不会重复请求 videoInfo）
    const info = await audioService.getInfo(bvid, quality, cid);

    // 将解析结果写入 URL 内存缓存，供 lazyResolve 即时命中
    setCachedUrl(
      bvid,
      info.audio.baseUrl,
      {
        Referer: 'https://www.bilibili.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      cid ?? info.cid,
    );
  } catch (error) {
    LoggerService.debug('dataPrefetcher', 'prefetchResolve', '预取音频 URL 失败:', error);
  }
}

/**
 * 滑动窗口数据预取：对当前活跃轨道之后的 N 个轨道发起低优先级异步纯数据预取。
 *
 * @param activeIndex 当前活跃轨道索引
 */
export async function prefetchNextTracks(activeIndex: number): Promise<void> {
  // 延迟执行，确保 UI 动画/导航优先完成
  await InteractionManager.runAfterInteractions();

  const windowSize = getWindowSize();
  if (windowSize <= 0) return;

  const queue = await TrackPlayer.getQueue();
  const start = activeIndex + 1;
  const end = Math.min(start + windowSize, queue.length);

  for (let i = start; i < end; i++) {
    const t = queue[i];
    if (t && String(t.url || '').startsWith('placeholder://')) {
      // 低优先级任务队列
      prefetchQueue.add(() => prefetchResolve(i), 'low').catch(() => {});
    }
  }
}

/**
 * 首曲预取：在 loadQueue/playFrom 等场景中，提前预取即将播放的首个轨道的音频 URL。
 *
 * @param startIndex 首曲在队列中的索引
 */
export async function prefetchFirstTrack(startIndex: number): Promise<void> {
  await InteractionManager.runAfterInteractions();
  const queue = await TrackPlayer.getQueue();
  const t = queue[startIndex];
  if (!t || !String(t.url || '').startsWith('placeholder://')) return;

  // 使用 normal 优先级（高于滑动窗口的 low），但低于活跃轨道解析
  prefetchQueue.add(() => prefetchResolve(startIndex), 'normal').catch(() => {});
}

/**
 * 立即获取指定 BVID/CID 的音频 URL 并缓存（用于手动触发预取）
 */
export async function prefetchAudioUrl(bvid: string, cid?: number): Promise<void> {
  const quality = useSettingsStore.getState().quality;
  try {
    const info = await audioService.getInfo(bvid, quality, cid);
    setCachedUrl(
      bvid,
      info.audio.baseUrl,
      {
        Referer: 'https://www.bilibili.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      cid ?? info.cid,
    );
  } catch (error) {
    LoggerService.debug('dataPrefetcher', 'prefetchAudioUrl', '主动预取音频 URL 失败:', error);
  }
}
