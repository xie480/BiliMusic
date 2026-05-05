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

export interface PlayContext {
  folderId?: number;
  sortOption?: string;
  searchQuery?: string;
}

interface PlayerState {
  queue: FavoriteVideo[];
  currentBvid: string | null;
  playbackError: string | null;
  playMode: 'sequential' | 'shuffle';
  originalQueue: FavoriteVideo[];
  playContext: PlayContext | null;
  /** 当前正在播放的分P的 cid，null 表示未解析或单P视频 */
  currentCid: number | null;
  /** 是否正在解析占位符音频资源 */
  isResolving: boolean;
  setQueue: (q: FavoriteVideo[], bvid?: string, context?: PlayContext) => void;
  setCurrentBvid: (bvid: string | null) => void;
  setPlaybackError: (msg: string | null) => void;
  setPlayMode: (mode: 'sequential' | 'shuffle') => void;
  setPlayContext: (context: PlayContext | null) => void;
  /** 更新当前 cid */
  setCurrentCid: (cid: number | null) => void;
  /** 设置解析状态 */
  setResolving: (resolving: boolean) => void;
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
    (set, get) => ({
      queue: [],
      currentBvid: null,
      currentCid: null,
      isResolving: false,
      playbackError: null,
      playMode: 'sequential',
      originalQueue: [],
      playContext: null,
      setQueue: (queue, bvid, context) =>
        set(state => ({
          queue,
          currentBvid: bvid ?? queue[0]?.bvid ?? null,
          originalQueue: queue,
          currentCid: null,
          playContext: context !== undefined ? context : state.playContext
        })),
      setCurrentBvid: (bvid) => set({ currentBvid: bvid }),
      setCurrentCid: (cid) => set({ currentCid: cid }),
      setResolving: (resolving) => set({ isResolving: resolving }),
      setPlayContext: (context) => set({ playContext: context }),
      updateVideoParts: (bvid, parts) => set(state => ({
        queue: state.queue.map(v => (v.bvid === bvid ? { ...v, parts } : v)),
        originalQueue: state.originalQueue.map(v => (v.bvid === bvid ? { ...v, parts } : v))
      })),
      setPlaybackError: (msg) => set({ playbackError: msg }),
      setPlayMode: (mode) => set({ playMode: mode }),
      togglePlayMode: () => {
        const state = get();
        if (state.playMode === 'sequential') {
          // Shuffle the queue while preserving original order
          // Keep current track at the top
          const currentBvid = state.currentBvid;
          const currentTrackIndex = state.queue.findIndex(v => v.bvid === currentBvid);
          
          let shuffled = [...state.queue];
          if (currentTrackIndex !== -1) {
            const currentTrack = shuffled.splice(currentTrackIndex, 1)[0];
            // Fisher-Yates shuffle for the rest
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            shuffled.unshift(currentTrack);
          } else {
            for (let i = shuffled.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
          }
          
          set({ playMode: 'shuffle', queue: shuffled });
          // Sync with TrackPlayer
          tpReorderQueue(shuffled, currentBvid ?? undefined).catch(console.error);
        } else {
          // Restore original order
          set({ playMode: 'sequential', queue: state.originalQueue });
          tpReorderQueue(state.originalQueue, state.currentBvid ?? undefined).catch(console.error);
        }
      },
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
        const currentBvid = get().currentBvid;
        set(state => ({
          queue: videos,
          originalQueue: state.playMode === 'sequential' ? videos : state.originalQueue,
        }));
        await tpReorderQueue(videos, currentBvid ?? startBvid ?? undefined);
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
