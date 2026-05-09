import { storage } from './storage';

interface Entry<T> {
  value: T;
  expireAt: number;
  lastAccess: number;
}

/** 用于 Promise 去重的挂起请求映射表 */
const pendingFetchers = new Map<string, Promise<any>>();

class TTLCache {
  private mem = new Map<string, Entry<any>>();
  private readonly maxEntries = 200; // 内存中最多 200 条

  /** 内存读取 */
  private getMem<T>(key: string): T | undefined {
    const e = this.mem.get(key);
    if (!e) return undefined;
    if (e.expireAt < Date.now()) {
      this.mem.delete(key);
      return undefined;
    }
    e.lastAccess = Date.now();
    return e.value as T;
  }

  /** 内存写入（含 LRU 淘汰）*/
  private setMem<T>(key: string, value: T, ttl: number) {
    if (this.mem.size >= this.maxEntries) {
      // 淘汰最久未访问的
      let oldestKey = '';
      let oldestTime = Infinity;
      for (const [k, v] of this.mem) {
        if (v.lastAccess < oldestTime) {
          oldestTime = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) this.mem.delete(oldestKey);
    }
    this.mem.set(key, {
      value,
      expireAt: Date.now() + ttl,
      lastAccess: Date.now(),
    });
  }

  /** 同时查内存和 MMKV */
  get<T>(key: string, persist = false): T | undefined {
    const m = this.getMem<T>(key);
    if (m !== undefined) return m;
    if (!persist) return undefined;

    const persisted = storage.getJSON<Entry<T>>(`cache:${key}`);
    if (!persisted) return undefined;
    if (persisted.expireAt < Date.now()) {
      storage.delete(`cache:${key}`);
      return undefined;
    }
    // 回填内存
    this.mem.set(key, { ...persisted, lastAccess: Date.now() });
    return persisted.value;
  }

  /** 设置缓存。persist=true 同步写入 MMKV */
  set<T>(key: string, value: T, ttl: number, persist = false) {
    this.setMem(key, value, ttl);
    if (persist) {
      storage.setJSON(`cache:${key}`, {
        value,
        expireAt: Date.now() + ttl,
        lastAccess: Date.now(),
      });
    }
  }

  delete(key: string) {
    this.mem.delete(key);
    storage.delete(`cache:${key}`);
  }

  /** 删除所有以 prefix 开头的 key */
  deletePrefix(prefix: string) {
    for (const k of Array.from(this.mem.keys())) {
      if (k.startsWith(prefix)) this.mem.delete(k);
    }
    storage.deletePrefix(`cache:${prefix}`);
  }

  /**
   * getOrSet 一站式：缓存命中则返回，否则调用 fetcher 并写入
   *
   * 【性能优化】Promise 去重：如果同一个 key 对应的 fetcher 已在执行中，
   * 后续的并发请求直接复用该 Promise，避免重复网络请求。
   * 这对于 eager prefetch + lazyResolve 的并发场景至关重要：
   *   1. VideosScreen 点击时调用 prefetchAudioUrl 启动网络请求
   *   2. loadQueue + playWithIntent 完成后，resolveCurrentTrack 内部也调用 getInfo
   *   3. 步骤 2 会直接复用步骤 1 的 Promise，无需发起第二次网络请求
   */
  async getOrSet<T>(
    key: string,
    ttl: number,
    fetcher: () => Promise<T>,
    persist = false
  ): Promise<T> {
    const hit = this.get<T>(key, persist);
    if (hit !== undefined) return hit;

    // Promise 去重：如果同一 key 已有挂起的 fetcher，直接复用
    const pendingKey = `__pending:${key}`;
    const existing = pendingFetchers.get(pendingKey);
    if (existing) return existing as Promise<T>;

    const promise = fetcher()
      .then((value) => {
        this.set(key, value, ttl, persist);
        pendingFetchers.delete(pendingKey);
        return value;
      })
      .catch((err) => {
        pendingFetchers.delete(pendingKey);
        throw err;
      });

    pendingFetchers.set(pendingKey, promise);
    return promise;
  }
}

export const cache = new TTLCache();
