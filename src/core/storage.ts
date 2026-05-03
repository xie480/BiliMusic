import { MMKV } from 'react-native-mmkv';
import type { FolderSyncMeta } from '../types/domain';

const mmkv = new MMKV({ id: 'bili-music' });

export { mmkv };

export const storage = {
  getString: (k: string) => mmkv.getString(k),
  setString: (k: string, v: string) => mmkv.set(k, v),
  getBool:   (k: string) => mmkv.getBoolean(k),
  setBool:   (k: string, v: boolean) => mmkv.set(k, v),
  getNumber: (k: string) => mmkv.getNumber(k),
  setNumber: (k: string, v: number) => mmkv.set(k, v),
  getJSON<T>(k: string): T | null {
    const s = mmkv.getString(k);
    if (!s) return null;
    try { return JSON.parse(s) as T; } catch { return null; }
  },
  setJSON: (k: string, v: any) => mmkv.set(k, JSON.stringify(v)),
  delete:  (k: string) => mmkv.delete(k),
  contains:(k: string) => mmkv.contains(k),
  getAllKeys: () => mmkv.getAllKeys(),
  /** 删除所有以 prefix 开头的 key */
  deletePrefix: (prefix: string) => {
    for (const k of mmkv.getAllKeys()) {
      if (k.startsWith(prefix)) mmkv.delete(k);
    }
  },

  // ─── 增量同步元数据存取 ───────────────────────────────
  /** 获取所有收藏夹的同步元数据 */
  getSyncMetaMap(): Record<number, FolderSyncMeta> {
    return this.getJSON<Record<number, FolderSyncMeta>>('syncMetaMap') || {};
  },

  /** 覆盖写入全部同步元数据（原子性保存） */
  setSyncMetaMap(map: Record<number, FolderSyncMeta>): void {
    this.setJSON('syncMetaMap', map);
  },

  /** 更新单个收藏夹的同步元数据（读-改-写，保证不丢失其他文件夹的元数据） */
  updateSyncMeta(folderId: number, meta: FolderSyncMeta): void {
    const map = this.getSyncMetaMap();
    map[folderId] = meta;
    this.setSyncMetaMap(map);
  },

  /** 删除单个收藏夹的同步元数据 */
  deleteSyncMeta(folderId: number): void {
    const map = this.getSyncMetaMap();
    delete map[folderId];
    this.setSyncMetaMap(map);
  },

  /** 清除全部同步元数据（恢复全量同步状态） */
  clearSyncMeta(): void {
    this.delete('syncMetaMap');
  },
};
