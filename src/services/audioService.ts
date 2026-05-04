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
};

function pickAudio(audios: ReturnType<typeof normalizeAudio>[], quality: Quality) {
  // 按带宽降序排列，优先匹配目标音质；若不存在则根据 Quality 优先级向下回退
  const sorted = [...audios].sort((a, b) => b.bandwidth - a.bandwidth);
  const qualityOrder: Quality[] = ['high', 'medium', 'low'];
  const startIdx = qualityOrder.indexOf(quality);
  for (let i = startIdx; i < qualityOrder.length; i++) {
    const targetId = QUALITY_MAP[qualityOrder[i]];
    const match = sorted.find((a) => a.id === targetId);
    if (match) return match;
  }
  // 若仍未匹配到任何音质，返回最高可用音质
  return sorted[0];
}

// 选择最快可用 CDN URL，使用并发 HEAD（或带 Range 的 GET）请求并缓存结果
async function selectFastestUrl(bvid: string, baseUrl: string, backupUrls: string[]): Promise<string> {
  const cacheKey = `fastestUrl:${bvid}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;
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
    return fastest;
  } catch {
    // 所有 CDN 均不可达，回退至原始 baseUrl
    cache.set(cacheKey, baseUrl, config.cacheTTL.audioUrl);
    return baseUrl;
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
          // videoInfo 单独缓存，与 quality 无关
          const info = await cache.getOrSet(
            `videoInfo:${bvid}`,
            config.cacheTTL.videoInfo,
            () => biliApi.getVideoInfo(bvid),
            true
          );
  
          const targetCid = cid ?? info.cid;
          const playUrl = await biliApi.getPlayUrl(bvid, targetCid);
          
          let audios = (playUrl.dash?.audio || []).map(normalizeAudio);
          
          // 如果没有 dash 音频流，尝试回退到 durl（MP4 混合流）
          if (audios.length === 0 && playUrl.durl && playUrl.durl.length > 0) {
            audios = playUrl.durl.map(d => ({
              id: 30216, // 默认给个低音质 ID
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
  
          // 构建分P信息（如果有的话）
          const parts = (info as any).pages?.map(p => ({
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
        false // 仅内存缓存，不持久化（URL 有时效）
      );
    },

  /** 强制刷新某 BV 的所有音质缓存（URL 失效时） */
  invalidate(bvid: string) {
    cache.deletePrefix(`audioInfo:${bvid}`);
  },
};
