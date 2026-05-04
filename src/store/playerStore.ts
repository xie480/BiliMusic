import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { FavoriteVideo } from '../types/domain';
import { storage } from '../core/storage';
import TrackPlayer from 'react-native-track-player';
import { loadQueue, insertNext as tpInsertNext, removeFromQueue as tpRemoveFromQueue, reorderQueue as tpReorderQueue, appendQueue as tpAppendQueue } from '../services/trackPlayer';

// MMKV storage adapter compatible with Zustand persist
const mmkvStorage = {
  getItem: (name: string) => Promise.resolve(storage.getString(name) ?? null),
  setItem: (name: string, value: string) => Promise.resolve(storage.setString(name, value)),
  removeItem: (name: string) => Promise.resolve(storage.delete(name)),
};

interface PlayerState {
  queue: FavoriteVideo[];
  currentBvid: string | null;
  playbackError: string | null;
  playMode: 'sequential' | 'shuffle';
  originalQueue: FavoriteVideo[];
  /** 当前正在播放的分P的 cid，null 表示未解析或单P视频 */
  currentCid: number | null;
  setQueue: (q: FavoriteVideo[], bvid?: string) => void;
  setCurrentBvid: (bvid: string | null) => void;
  setPlaybackError: (msg: string | null) => void;
  setPlayMode: (mode: 'sequential' | 'shuffle') => void;
  /** 更新当前 cid */
  setCurrentCid: (cid: number | null) => void;
  togglePlayMode: () => void;
  insertNext: (video: FavoriteVideo) => Promise<void>;
  removeFromQueue: (bvid: string) => Promise<void>;
  reorderQueue: (videos: FavoriteVideo[], startBvid?: string) => Promise<void>;
  appendQueue: (videos: FavoriteVideo[], startBvid?: string) => Promise<void>;
  /** 在队列中更新特定视频的 parts 信息 */
  updateVideoParts: (bvid: string, parts: any[]) => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      queue: [],
      currentBvid: null,
      currentCid: null,
      playbackError: null,
      playMode: 'sequential',
      originalQueue: [],
      setQueue: (queue, bvid) =>
        set({ queue, currentBvid: bvid ?? queue[0]?.bvid ?? null, originalQueue: queue, currentCid: null }),
      setCurrentBvid: (bvid) => set({ currentBvid: bvid }),
      setCurrentCid: (cid) => set({ currentCid: cid }),
      updateVideoParts: (bvid, parts) => set(state => ({
        queue: state.queue.map(v => (v.bvid === bvid ? { ...v, parts } : v)),
        originalQueue: state.originalQueue.map(v => (v.bvid === bvid ? { ...v, parts } : v))
      })),
      setPlaybackError: (msg) => set({ playbackError: msg }),
      setPlayMode: (mode) => set({ playMode: mode }),
      togglePlayMode: () => set(state => {
        if (state.playMode === 'sequential') {
          // Shuffle the queue while preserving original order
          const shuffled = [...state.queue].sort(() => Math.random() - 0.5);
          return { playMode: 'shuffle', queue: shuffled };
        } else {
          // Restore original order
          return { playMode: 'sequential', queue: state.originalQueue };
        }
      }),
      // Insert a video to be played next after the current track
      insertNext: async (video) => {
        await tpInsertNext(video);
      },
      // Remove a specific video from the queue by BVID
      removeFromQueue: async (bvid) => {
        await tpRemoveFromQueue(bvid);
      },
      // Reorder entire queue (replace)
      reorderQueue: async (videos, startBvid) => {
        await tpReorderQueue(videos, startBvid);
      },
      // Append a list of videos to the end of the queue
      appendQueue: async (videos, startBvid) => {
        await tpAppendQueue(videos, startBvid);
      },
    }),
    {
      name: 'playerStore',
      storage: createJSONStorage(() => mmkvStorage),
    },
  ),
);
