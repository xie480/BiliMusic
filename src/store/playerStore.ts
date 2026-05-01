import { create } from 'zustand';
import type { FavoriteVideo } from '../types/domain';

interface PlayerState {
  queue: FavoriteVideo[];
  currentBvid: string | null;
  setQueue: (q: FavoriteVideo[], bvid?: string) => void;
  setCurrentBvid: (bvid: string | null) => void;
}

export const usePlayerStore = create<PlayerState>((set) => ({
  queue: [],
  currentBvid: null,
  setQueue: (queue, bvid) =>
    set({ queue, currentBvid: bvid ?? queue[0]?.bvid ?? null }),
  setCurrentBvid: (bvid) => set({ currentBvid: bvid }),
}));
