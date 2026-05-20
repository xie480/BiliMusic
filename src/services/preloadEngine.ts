/**
 * 智能预加载引擎 (PreloadEngine)
 *
 * 基于原生层网络请求的完整音频资源预加载机制。
 *
 * ─── 核心职责 ───
 * 1. 在当前音轨成功加载并进入播放状态后，立即触发对后续 5 首歌曲的预加载
 * 2. 建立严格的防重复加载校验，通过全局缓存状态集合 + URL 缓存 + 磁盘缓存
 *    的三重防线，确保任何已加载/加载中的音频资源绝不重复请求
 * 3. 完整预加载链路：音频 URL 解析 → 原生网络请求下载到磁盘缓存
 *
 * ─── 防重复加载校验体系 ───
 * 第一道防线：_preloadingOrCached 全局 Set（O(1) 内存判重）
 * 第二道防线：urlCache 内存缓存（已解析的 CDN URL）
 * 第三道防线：audioCache 磁盘缓存（已下载到本地的音频文件）
 *
 * ─── 与旧的 dataPrefetcher 的区别 ───
 * - dataPrefetcher 只解析 URL 存入内存缓存（urlCache），不做磁盘下载
 * - preloadEngine 解析 URL 后还会发起原生层网络请求下载音频文件到磁盘
 * - preloadEngine 预加载数量固定为 5，且触发于"成功播放"而非"轨道变更"
 * - preloadEngine 有严格的全局去重机制
 *
 * ─── 生命周期 ───
 * - 初始化：lazyResolve 成功替换 + 播放状态切换为 Playing 时触发
 * - 清理：loadQueue / reset / reorderQueue 时由外部调用 resetPreloadState()
 * - 重试：单个预加载失败时从 _preloadingOrCached 移除，允许后续重试
 */

import TrackPlayer from 'react-native-track-player';
import { InteractionManager } from 'react-native';
import LoggerService from './LoggerService';
import { audioService } from './audioService';
import { audioCache } from './audioCache';
import { useSettingsStore } from '../store/settingsStore';
import { usePlayerStore } from '../store/playerStore';
import { config } from '../config';
import { setCachedUrl, getCachedUrl } from './urlCache';
import { TaskQueue } from '../utils/taskQueue';

// ============================================================
// 常量配置
// ============================================================

/** 每次触发时预加载的歌曲数量 */
const PRELOAD_COUNT = 5;

/** 预加载任务队列并发度（混合磁盘 I/O 与网络请求，设 3 较为适中） */
const PRELOAD_CONCURRENCY = 3;

// ============================================================
// 全局预加载任务队列
// ============================================================

const preloadTaskQueue = new TaskQueue(PRELOAD_CONCURRENCY);

// ============================================================
// 防重复加载校验系统
// ============================================================

/**
 * 全局缓存状态记录集合。
 *
 * key 格式：`${bvid}:${quality}:${cid ?? 'default'}`
 *
 * 包含所有已确认无需重复加载的音频资源：
 * - 已在 urlCache 中有缓存条目的
 * - 已在 audioCache 磁盘缓存中的
 * - 当前正在预加载中的
 * - 已由 lazyResolve 完成解析注入的
 *
 * 集合的写入时机：
 * - 三方缓存任意一方命中
 * - 预加载任务开始时
 *
 * 集合的清理时机（由外部显式调用 resetPreloadState）：
 * - loadQueue（新队列加载）
 * - reorderQueue（队列重排）
 * - appendQueue（批量追加）
 * - reset（播放器重置）
 * - setupPlayer（播放器初始化）
 */
const _preloadingOrCached = new Set<string>();

/** 用于构造预加载去重键的当前音质缓存 */
let _cachedQuality: string | null = null;

/**
 * 构造预加载任务的唯一缓存键。
 * 包含音质信息，确保不同音质下的同视频不被误判为已缓存。
 */
function preloadCacheKey(bvid: string, cid?: number): string {
  const quality = _cachedQuality ?? useSettingsStore.getState().quality;
  return cid != null ? `${bvid}:${quality}:${cid}` : `${bvid}:${quality}`;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 重置预加载引擎的全局缓存状态。
 *
 * 必须在以下场景中由外部调用：
 * - loadQueue：新队列开始，完全清除旧状态
 * - reorderQueue：队列重排后，部分预加载可能已不再需要
 * - appendQueue：新轨道追加后，重置去重状态以覆盖新轨道
 * - setupPlayer / reset：播放器重置
 * - 清空所有待处理的低优先级预加载任务
 */
export function resetPreloadState(): void {
  _preloadingOrCached.clear();
  _cachedQuality = null;
  preloadTaskQueue.clearLowPriority();
  LoggerService.debug('PreloadEngine', 'resetPreloadState', '预加载缓存状态已重置');
}

/**
 * 同步检查指定音频资源是否已处于"无需重复加载"的状态。
 *
 * 此函数供外部模块（如 lazyResolve）在发起网络请求前先调用，
 * 避免预加载引擎已处理过的资源被重复解析。
 *
 * 注意：此函数为纯同步查内存集合，不发起任何异步 I/O。
 * 对于 urlCache / audioCache 的检查在预加载路径内部异步完成。
 *
 * @param bvid 视频 BVID
 * @param cid  可选分P CID
 * @returns true 表示该资源已被预加载引擎处理过（加载中或已完成）
 */
export function isAudioQueuedOrCached(bvid: string, cid?: number): boolean {
  const key = preloadCacheKey(bvid, cid);
  return _preloadingOrCached.has(key);
}

/**
 * 将指定音频标记为已缓存状态。
 *
 * 供 lazyResolve 在完成真实 URL 替换后调用，将当前轨道
 * 记入去重集合，避免后续预加载引擎重复触发。
 *
 * @param bvid 视频 BVID
 * @param cid  可选分P CID
 */
export function markAudioAsCached(bvid: string, cid?: number): void {
  const key = preloadCacheKey(bvid, cid);
  _preloadingOrCached.add(key);
  LoggerService.debug('PreloadEngine', 'markAudioAsCached',
    `标记为已缓存 (BVID: ${bvid}, CID: ${cid ?? 'default'})`);
}

// ============================================================
// 内部实现
// ============================================================

/**
 * 三重防重复校验：检查指定音频是否已被处理。
 *
 * @returns true 表示该资源已被处理（无需重复加载）
 */
async function isAlreadyProcessed(bvid: string, cid?: number): Promise<boolean> {
  const quality = useSettingsStore.getState().quality;
  _cachedQuality = quality;
  const key = preloadCacheKey(bvid, cid);

  // ====== 第一道防线：内存集合 O(1) 判重 ======
  if (_preloadingOrCached.has(key)) {
    LoggerService.debug('PreloadEngine', 'isAlreadyProcessed',
      `[第一道防线] 内存状态命中 (BVID: ${bvid})`);
    return true;
  }

  // ====== 第二道防线：urlCache 内存缓存 ======
  const cachedUrlEntry = getCachedUrl(bvid, cid);
  if (cachedUrlEntry) {
    _preloadingOrCached.add(key);
    LoggerService.debug('PreloadEngine', 'isAlreadyProcessed',
      `[第二道防线] URL 缓存命中 (BVID: ${bvid})`);
    return true;
  }

  // ====== 第三道防线：audioCache 磁盘缓存 ======
  try {
    // 【关键】audioCache 使用 `${bvid}${cid ? '-'+cid : ''}` 作为 key，
    // 必须与 lazyResolve 中的 cacheKey 格式一致才能命中已下载的缓存文件
    const cacheKey = cid ? `${bvid}-${cid}` : bvid;
    const cachedPath = await audioCache.has(cacheKey, quality);
    if (cachedPath) {
      _preloadingOrCached.add(key);
      LoggerService.debug('PreloadEngine', 'isAlreadyProcessed',
        `[第三道防线] 磁盘缓存命中 (BVID: ${bvid}, CID: ${cid ?? 'default'})`);
      return true;
    }
  } catch {
    // 磁盘缓存检查失败，不阻塞预加载流程，继续尝试下载
  }

  return false;
}

/**
 * 预加载单个轨道的完整音频资源。
 *
 * 完整链路：URL 解析（如尚未缓存） → 原生网络请求下载到磁盘缓存
 *
 * 错误处理策略：
 * - 解析 URL 失败：仅输出 debug 日志，不影响其他轨道的预加载
 * - 磁盘下载失败：从 _preloadingOrCached 移除该条目，允许后续重试
 * - 所有异常均被捕获，不会上抛污染调用方
 */
async function preloadSingleTrack(bvid: string, cid?: number): Promise<void> {
  const quality = useSettingsStore.getState().quality;
  _cachedQuality = quality;
  const key = preloadCacheKey(bvid, cid);

  // 最终防线：写入内存集合前再检查一次（防止并发竞态）
  if (_preloadingOrCached.has(key)) return;
  _preloadingOrCached.add(key);

  try {
    // -------- 第一步：解析音频 URL（如果未缓存） --------
    let url: string;
    let headers: Record<string, string> | undefined;
    let resolvedCid = cid;

    const cachedUrlEntry = getCachedUrl(bvid, cid);
    if (cachedUrlEntry) {
      // URL 缓存命中：直接使用已有条目
      url = cachedUrlEntry.url;
      headers = cachedUrlEntry.headers;
    } else {
      // URL 缓存未命中：调用 audioService.getInfo 解析
      // 注意：getInfo 内部有 24h videoInfo 缓存 + 1h audioUrl 缓存，
      // 不会因 preloadEngine 的调用而增加 API 请求量。
      const info = await audioService.getInfo(bvid, quality, cid);
      url = info.audio.baseUrl;
      resolvedCid = cid ?? info.cid;
      headers = {
        Referer: config.referer,
        'User-Agent': config.userAgent,
      };
      // 将解析结果写入 URL 内存缓存，供 lazyResolve 即时命中
      setCachedUrl(bvid, url, headers, resolvedCid);
    }

    // -------- 第二步：原生层网络请求下载到磁盘缓存 --------
    const cacheKey = resolvedCid ? `${bvid}-${resolvedCid}` : bvid;
    const videoInQueue = usePlayerStore.getState().queue.find(v => v.bvid === bvid);
    const noCacheFolderIds = useSettingsStore.getState().noCacheFolderIds;
    const isNoCache = videoInQueue?.folderIds?.some(
      id => noCacheFolderIds?.includes(id),
    ) ?? false;

    if (!isNoCache) {
      // audioCache.download 内部已有 downloading Map 做并发下载去重，
      // 此处即使多个路径同时发起同一音频的下载请求也不会重复下载。
      await audioCache.download(cacheKey, quality, url, headers);
    }

    LoggerService.info(
      'PreloadEngine', 'preloadSingleTrack',
      `预加载完成 (BVID: ${bvid}, CID: ${resolvedCid ?? 'default'})`,
    );
  } catch (error) {
    LoggerService.debug(
      'PreloadEngine', 'preloadSingleTrack',
      `预加载失败 (BVID: ${bvid}):`, error,
    );
    // 预加载失败后从内存集合中移除，允许后续再次尝试
    _preloadingOrCached.delete(key);
  }
}

/**
 * 触发预加载流程：对当前活跃轨道之后的后续 N 首歌曲执行完整预加载。
 *
 * 调用时机（由 trackPlayer.ts 中的 PlaybackState 事件处理器在检测到
 * State.Playing 且当前轨道非占位符时调用）：
 * - 当前音轨成功加载并顺利进入播放状态后
 * - lazyResolve 完成占位符替换并播放后
 *
 * 预加载范围：activeIndex + 1 到 activeIndex + PRELOAD_COUNT
 * 超出队列范围时自动截断。
 *
 * 防重复保障：
 * 1. 循环中逐轨道调用 isAlreadyProcessed 做三重校验
 * 2. preloadSingleTrack 入口处再次检查 _preloadingOrCached
 * 3. audioCache.download 内部有 downloading Map 做最终去重
 *
 * @param activeIndex 当前活跃轨道在原生队列中的索引
 */
export async function triggerPreload(activeIndex: number): Promise<void> {
  // 延迟执行，确保 UI 动画 / 导航优先完成，不抢占用户交互
  await InteractionManager.runAfterInteractions();

  const queue = await TrackPlayer.getQueue();
  if (!queue || queue.length === 0) {
    LoggerService.debug('PreloadEngine', 'triggerPreload', '队列为空，跳过预加载');
    return;
  }

  // 计算待预加载的范围：后续 PRELOAD_COUNT 首
  const start = activeIndex + 1;
  const end = Math.min(start + PRELOAD_COUNT, queue.length);

  if (start >= end) {
    LoggerService.debug('PreloadEngine', 'triggerPreload',
      `队列剩余歌曲不足 (activeIndex=${activeIndex}, queue.length=${queue.length})，跳过预加载`);
    return;
  }

  LoggerService.info(
    'PreloadEngine', 'triggerPreload',
    `开始预加载后续歌曲 (范围: ${start} ~ ${end - 1}, 共 ${end - start} 首)`,
  );

  for (let i = start; i < end; i++) {
    const t = queue[i];
    if (!t) continue;

    const bvid = (t as any).bvid || (t.id as string);
    if (!bvid) continue;

    const cid = (t as any).cid as number | undefined;

    // ====== 防重复加载校验 ======
    const alreadyProcessed = await isAlreadyProcessed(bvid, cid);
    if (alreadyProcessed) {
      LoggerService.debug(
        'PreloadEngine', 'triggerPreload',
        `跳过已加载音频 (BVID: ${bvid}, CID: ${cid ?? 'default'}) - 防重复校验命中`,
      );
      continue;
    }

    // 将预加载任务提交到队列
    preloadTaskQueue.add(
      () => preloadSingleTrack(bvid, cid),
      'normal',
    ).catch(() => {
      // preloadSingleTrack 内部已捕获所有异常，此处的 catch 仅为
      // 防止未处理的 Promise rejection 触发 UnhandledPromiseRejection
    });
  }
}
