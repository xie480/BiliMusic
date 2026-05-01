import md5 from 'md5';
import axios from 'axios';
import { config } from '../config';
import { storage } from './storage';
import type { BiliWbiKeys } from '../types/bili';

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function getMixinKey(orig: string): string {
  return mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);
}

export function encWbi(
  params: Record<string, any>,
  imgKey: string,
  subKey: string
): string {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const chrFilter = /[!'()*]/g;
  const finalParams: Record<string, any> = { ...params, wts };

  const query = Object.keys(finalParams)
    .sort()
    .map((key) => {
      const v = String(finalParams[key]).replace(chrFilter, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

interface CachedKeys extends BiliWbiKeys {
  fetchedAt: number;
}

/**
 * 获取 WBI 密钥，带 1 小时持久化缓存
 * 注意：此处不走 biliGet（避免循环依赖），直接用裸 axios
 */
export async function getWbiKeys(): Promise<BiliWbiKeys> {
  const cached = storage.getJSON<CachedKeys>('wbiKeys');
  if (cached && Date.now() - cached.fetchedAt < config.cacheTTL.wbiKeys) {
    return { imgKey: cached.imgKey, subKey: cached.subKey };
  }

  const { data } = await axios.get(
    `${config.biliBaseURL}/x/web-interface/nav`,
    {
      headers: {
        'User-Agent': config.userAgent,
        Referer: config.referer,
        Cookie: storage.getString('biliCookie') || '',
      },
      timeout: config.httpTimeout,
    }
  );

  const imgUrl: string = data?.data?.wbi_img?.img_url || '';
  const subUrl: string = data?.data?.wbi_img?.sub_url || '';
  if (!imgUrl || !subUrl) throw new Error('获取 WBI 密钥失败');

  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'));
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'));

  storage.setJSON('wbiKeys', { imgKey, subKey, fetchedAt: Date.now() });
  return { imgKey, subKey };
}
