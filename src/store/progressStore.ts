import { create } from 'zustand';
import TrackPlayer from 'react-native-track-player';

interface ProgressState {
  position: number;
  duration: number;
  buffered: number;
  updateProgress: (position: number, duration: number, buffered: number) => void;
  resetProgress: () => void;
}

export const useProgressStore = create<ProgressState>((set) => ({
  position: 0,
  duration: 0,
  buffered: 0,
  updateProgress: (position, duration, buffered) => set({ position, duration, buffered }),
  resetProgress: () => set({ position: 0, duration: 0, buffered: 0 }),
}));

let progressInterval: NodeJS.Timeout | null = null;

export const startProgressPolling = (intervalMs = 1000) => {
  if (progressInterval) return;
  
  progressInterval = setInterval(async () => {
    try {
      const progress = await TrackPlayer.getProgress();
      useProgressStore.getState().updateProgress(progress.position, progress.duration, progress.buffered);
    } catch (e) {
      // Ignore errors, player might not be ready
    }
  }, intervalMs);
};

export const stopProgressPolling = () => {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
};
