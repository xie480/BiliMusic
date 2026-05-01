import RNFS from 'react-native-fs';
import { storage } from '../core/storage';
import type { Quality } from '../types/domain';

const CACHE_DIR = `${RNFS.DocumentDirectoryPath}/audio_cache`;
const META_KEY = 'audioCache:meta';
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

interface CacheItem {
  bvid: string;
  quality: Quality;
  path: string;
  size: number;
  lastAccess: number;
}
type MetaMap = Record<string, CacheItem>;

class AudioCache {
  private ready: Promise<void>;
  private downloading = new Map<string, Promise<string>>();

  constructor() {
    this.ready = this.init();
  }
  private async init() {
    if (!(await RNFS.exists(CACHE_DIR))) {
      await RNFS.mkdir(CACHE_DIR);
    }
  }
  private getMeta = (): MetaMap => storage.getJSON<MetaMap>(META_KEY) || {};
  private setMeta = (m: MetaMap) => storage.setJSON(META_KEY, m);
  private key = (b: string, q: Quality) => `${b}:${q}`;

  async has(bvid: string, quality: Quality): Promise<string | null> {
    await this.ready;
    const meta = this.getMeta();
    const item = meta[this.key(bvid, quality)];
    if (!item) return null;
    if (!(await RNFS.exists(item.path))) {
      delete meta[this.key(bvid, quality)];
      this.setMeta(meta);
      return null;
    }
    item.lastAccess = Date.now();
    this.setMeta(meta);
    return item.path;
  }

  async download(
    bvid: string,
    quality: Quality,
    streamUrl: string,
    headers?: Record<string, string>
  ): Promise<string> {
    await this.ready;
    const cacheKey = this.key(bvid, quality);

    // 防止同一音频并发下载导致重复写入文件或缓存冲突
    if (this.downloading.has(cacheKey)) {
      return this.downloading.get(cacheKey)!;
    }

    // 检查是否已有缓存
    const existing = await this.has(bvid, quality);
    if (existing) return existing;

    const downloadPromise = (async () => {
      const filePath = `${CACHE_DIR}/${bvid}_${quality}.m4a`;
      try {
        const result = await RNFS.downloadFile({
          fromUrl: streamUrl,
          toFile: filePath,
          headers,
          background: true,
          discretionary: true,
        }).promise;

        if (result.statusCode !== 200 && result.statusCode !== 206) {
          // 清理可能的残留文件以防止缓存误判
          try {
            if (await RNFS.exists(filePath)) {
              await RNFS.unlink(filePath);
            }
          } catch {}
          throw new Error(`下载失败 ${result.statusCode}`);
        }

        const stat = await RNFS.stat(filePath);
        const meta = this.getMeta();
        meta[cacheKey] = {
          bvid,
          quality,
          path: filePath,
          size: Number(stat.size),
          lastAccess: Date.now(),
        };
        this.setMeta(meta);
        // 触发空间回收（不需要 await，后台执行即可）
        this.tryEvict();
        return filePath;
      } catch (error) {
        // 下载异常，清理残余文件
        try {
          if (await RNFS.exists(filePath)) {
            await RNFS.unlink(filePath);
          }
        } catch (cleanupError) {
          console.error('清理残余缓存文件失败:', cleanupError);
        }
        throw error;
      } finally {
        // 下载结束后移除记录，确保后续请求能重新触发下载（若失败则会重新尝试）
        this.downloading.delete(cacheKey);
      }
    })();

    this.downloading.set(cacheKey, downloadPromise);
    return downloadPromise;
  }

  getTotalSize(): number {
    return Object.values(this.getMeta()).reduce((s, it) => s + (it.size || 0), 0);
  }
  getCount(): number {
    return Object.keys(this.getMeta()).length;
  }

  private async tryEvict() {
    let total = this.getTotalSize();
    if (total <= MAX_BYTES) return;
    const meta = this.getMeta();
    const items = Object.entries(meta).sort(
      ([, a], [, b]) => a.lastAccess - b.lastAccess
    );
    for (const [key, item] of items) {
      if (total <= MAX_BYTES * 0.9) break;
      try {
        if (await RNFS.exists(item.path)) await RNFS.unlink(item.path);
      } catch {}
      total -= item.size;
      delete meta[key];
    }
    this.setMeta(meta);
  }

  async clearAll() {
    await this.ready;
    const meta = this.getMeta();
    for (const item of Object.values(meta)) {
      try {
        if (await RNFS.exists(item.path)) await RNFS.unlink(item.path);
      } catch {}
    }
    this.setMeta({});
  }
}

export const audioCache = new AudioCache();
