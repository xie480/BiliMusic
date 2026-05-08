import { biliApi } from './biliApi';
import { cache } from '../core/cache';
import { config } from '../config';
import { normalizeAudio } from './transformers';
import { ResourceUnavailableError } from '../core/errors';
import type { AudioInfo, Quality } from '../types/domain';

const QUALITY_MAP: Record<Quality, number> = {
  low: 30216,    //  64 K
  medium: 30232, // 132 K
  high: 30280,   // 192 K
  dolby: 30250,  // 杜比全景声 Dolby Atmos
  hires: 30251,  // HI-FES 无损
};

/** 音质回退优先级（低索引 → 高优先级，越靠前越优先尝试匹配） */
const QUALITY_ORDER: Quality[] = ['hires', 'dolby', 'high', 'medium', 'low'];

function pickAudio(audios: ReturnType<typeof normalizeAudio>[], quality: Quality) {
  const sorted = [...audios].sort((a, b) => b.bandwidth - a.bandwidth);
  const startIdx = QUALITY_ORDER.indexOf(quality);
  if (startIdx === -1) {
    return sorted[0];
  }
  for (let i = startIdx; i < QUALITY_ORDER.length; i++) {
    const targetId = QUALITY_MAP[QUALITY_ORDER[i]];
    const match = sorted.find((a) => a.id === targetId);
    if (match) return match;
  }
  return sorted[0];
}

/** 从 URL 中提取域名 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** 全局 CDN 域名测速缓存：避免对同一域名的每个 BVID 重复 HEAD 请求 */
const domainSpeedCache = new Map<string, { fastestBaseUrl: string; timestamp: number }>();
const DOMAIN_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

/**
 * 基于域名缓存的快速 URL 选择
 * - 如果当前 baseUrl 所在域名已被测速为最快，跳过 HEAD 请求直接使用
 * - 如果当前 baseUrl 域名未知，执行测速并缓存结果
 */
async function selectFastestUrl(bvid: string, baseUrl: string, backupUrls: string[]): Promise<string> {
  const cacheKey = `fastestUrl:${bvid}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const domain = extractDomain(baseUrl);
  const now = Date.now();

  // 域名级缓存命中：直接返回该域名下的最快 URL，跳过 HEAD 请求
  const domainEntry = domainSpeedCache.get(domain);
  if (domainEntry && (now - domainEntry.timestamp) < DOMAIN_CACHE_TTL) {
    cache.set(cacheKey, domainEntry.fastestBaseUrl, config.cacheTTL.audioUrl);
    return domainEntry.fastestBaseUrl;
  }

  const urls = [baseUrl, ...(backupUrls || [])];
  const tryUrl = async (url: string): Promise<string> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const commonHeaders = {
      'User-Agent': config.userAgent,
      Referer: config.referer,
    };
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: commonHeaders,
        signal: controller.signal,
      });
      if (res.ok) return url;
    } catch {}
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { ...commonHeaders, Range: 'bytes=0-0' },
        signal: controller.signal,
      });
      if (res.ok) return url;
    } catch {}
    throw new Error('unreachable');
  };

  try {
    const fastest = await Promise.any(urls.map(tryUrl));
    cache.set(cacheKey, fastest, config.cacheTTL.audioUrl);
    // 缓存域名级结果
    const fastestDomain = extractDomain(fastest);
    if (fastestDomain) {
      domainSpeedCache.set(fastestDomain, { fastestBaseUrl: fastest, timestamp: now });
    }
    return fastest;
  } catch {
    cache.set(cacheKey, baseUrl, config.cacheTTL.audioUrl);
    // 即使全部失败，也缓存域名结果避免重复测速
    if (domain) {
      domainSpeedCache.set(domain, { fastestBaseUrl: baseUrl, timestamp: now });
    }
    return baseUrl;
  }
}

/** 清除指定的域名级测速缓存（用于手动刷新或错误恢复） */
export function invalidateDomainCache(domain?: string) {
  if (domain) {
    domainSpeedCache.delete(domain);
  } else {
    domainSpeedCache.clear();
  }
}

export const audioService = {
  /**
   * 获取音频元信息
   *
   * 流程：
   * 1. videoInfo 缓存 1 天（标题等基本不变）
   * 2. audioUrl 缓存 1 小时（B 站 URL 约 2 小时失效）
   */
  async getInfo(bvid: string, quality: Quality = 'low', cid?: number): Promise<AudioInfo> {
      if (!QUALITY_MAP[quality]) {
        throw new Error(`无效的音质参数: ${quality}`);
      }
  
      const cacheKey = `audioInfo:${bvid}:${cid ?? 'default'}:${quality}`;
      return cache.getOrSet(
        cacheKey,
        config.cacheTTL.audioUrl,
        async () => {
          const info = await cache.getOrSet(
            `videoInfo:${bvid}`,
            config.cacheTTL.videoInfo,
            () => biliApi.getVideoInfo(bvid),
            true
          );
  
          const targetCid = cid ?? info.cid;
          const playUrl = await biliApi.getPlayUrl(bvid, targetCid);
          
          let audios = (playUrl.dash?.audio || []).map(normalizeAudio);
          
          if (audios.length === 0 && playUrl.durl && playUrl.durl.length > 0) {
            audios = playUrl.durl.map(d => ({
              id: 30216,
              bandwidth: 0,
              mimeType: 'audio/mp4',
              baseUrl: d.url,
              backupUrl: d.backup_url || [],
            }));
          }
  
          if (audios.length === 0) {
            throw new ResourceUnavailableError('该视频无可用音频流');
          }
          const audio = pickAudio(audios, quality);

          const parts = (info as any).pages?.map((p: any) => ({
            cid: p.cid,
            page: p.page,
            title: p.part,
            duration: p.duration,
          })) ?? [];
  
          return {
            bvid,
            cid: targetCid,
            title: info.title,
            cover: info.pic,
            author: info.owner?.name || '',
            duration: info.duration,
            audio: {
              id: audio.id,
              bitrate: Math.round((audio.bandwidth || 0) / 1000),
              mimeType: audio.mimeType,
              baseUrl: await selectFastestUrl(bvid, audio.baseUrl, audio.backupUrl),
              backupUrl: audio.backupUrl,
            },
            parts,
          };
        },
        false
      );
    },

  /** 强制刷新某 BV 的所有音质缓存 */
  invalidate(bvid: string) {
    cache.deletePrefix(`audioInfo:${bvid}`);
  },
};
