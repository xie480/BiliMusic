import TrackPlayer, {
  AppKilledPlaybackBehavior, Capability, Event,
} from 'react-native-track-player';
import { audioService } from './audioService';
import { audioCache } from './audioCache';
import { netStatus } from './netStatus';
import { useSettingsStore } from '../store/settingsStore';
import { config } from '../config';
import type { FavoriteVideo } from '../types/domain';

let _ready = false;

export async function setupPlayer() {
  if (_ready) return;
  try {
    await TrackPlayer.setupPlayer({ autoHandleInterruptions: true });
    await TrackPlayer.updateOptions({
      android: {
        appKilledPlaybackBehavior:
          AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification,
      },
      capabilities: [
        Capability.Play, Capability.Pause,
        Capability.SkipToNext, Capability.SkipToPrevious,
        Capability.SeekTo, Capability.Stop,
      ],
      compactCapabilities: [
        Capability.Play, Capability.Pause, Capability.SkipToNext,
      ],
      progressUpdateEventInterval: 1,
    });
  } catch {}
  _ready = true;
}

async function buildTrack(v: FavoriteVideo) {
  const quality = useSettingsStore.getState().quality;
  const cached = await audioCache.has(v.bvid, quality);
  if (cached) {
    return {
      id: v.bvid, url: `file://${cached}`,
      title: v.title, artist: v.upper.name,
      artwork: v.cover, duration: v.duration,
    };
  }
  const info = await audioService.getInfo(v.bvid, quality);
  return {
    id: v.bvid, url: info.audio.baseUrl,
    title: v.title, artist: v.upper.name,
    artwork: v.cover, duration: v.duration,
    headers: { Referer: config.referer, 'User-Agent': config.userAgent },
  };
}

export async function loadQueue(videos: FavoriteVideo[], startBvid?: string) {
  await TrackPlayer.reset();
  const startIndex = Math.max(0, videos.findIndex((v) => v.bvid === startBvid));
  const current = await buildTrack(videos[startIndex]);

  const tracks = videos.map((v, i) =>
    i === startIndex ? current : {
      id: v.bvid, url: `placeholder://${v.bvid}`,
      title: v.title, artist: v.upper.name,
      artwork: v.cover, duration: v.duration,
    }
  );
  await TrackPlayer.add(tracks);
  await TrackPlayer.skip(startIndex);
}

async function lazyResolve(index: number) {
  const queue = await TrackPlayer.getQueue();
  const t = queue[index];
  if (!t || !String(t.url).startsWith('placeholder://')) return;
  
  const bvid = String(t.url).replace('placeholder://', '');
  const quality = useSettingsStore.getState().quality;
  
  let url = '';
  let headers: Record<string, string> | undefined;
  
  const cached = await audioCache.has(bvid, quality);
  if (cached) {
    url = `file://${cached}`;
  } else {
    const info = await audioService.getInfo(bvid, quality);
    url = info.audio.baseUrl;
    headers = { Referer: config.referer, 'User-Agent': config.userAgent };
  }

  const newTrack = { ...t, url, headers };
  
  // 无缝替换策略：插入真实音频 -> 跳至真实音频 -> 移除旧占位音频
  await TrackPlayer.add(newTrack, index + 1);
  await TrackPlayer.skip(index + 1);
  await TrackPlayer.remove(index);
}

async function autoCache(bvid: string) {
  const s = useSettingsStore.getState();
  if (!s.autoCacheOnWifi || !netStatus.isWifi()) return;
  if (await audioCache.has(bvid, s.quality)) return;
  try {
    const info = await audioService.getInfo(bvid, s.quality);
    await audioCache.download(bvid, s.quality, info.audio.baseUrl, {
      Referer: config.referer, 'User-Agent': config.userAgent,
    });
  } catch {}
}

export async function PlaybackService() {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteSeek, ({ position }) =>
    TrackPlayer.seekTo(position)
  );

  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (e) => {
    if (e.index !== undefined) await lazyResolve(e.index);
    if (e.lastTrack?.id) autoCache(e.lastTrack.id as string);
  });
}
