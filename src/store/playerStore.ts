import { create } from 'zustand';
import type { FavoriteVideo } from '../types/domain';

interface PlayerState {
  queue: FavoriteVideo[];
  currentBvid: string | null;
  playbackError: string | null;
  setQueue: (q: FavoriteVideo[], bvid?: string) => void;
  setCurrentBvid: (bvid: string | null) => void;
  setPlaybackError: (err: string | null) => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  queue: [],
  currentBvid: null,
  playbackError: null,
  setQueue: (queue, bvid) =>
    set({ queue, currentBvid: bvid ?? queue[0]?.bvid ?? null }),
  setCurrentBvid: (bvid) => set({ currentBvid: bvid }),
  setPlaybackError: (err) => set({ playbackError: err }),
}));
