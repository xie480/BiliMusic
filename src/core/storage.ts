import { MMKV } from 'react-native-mmkv';

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
};
