import React from 'react';
import { View, Text, StyleSheet, StatusBar } from 'react-native';
import FastImage from 'react-native-fast-image';
import TrackPlayer, {
  useActiveTrack, usePlaybackState, useProgress, State,
} from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from '../components/IconButton';
import { useUIStore } from '../store/uiStore';
import { PlaylistPanel } from '../components/PlaylistPanel';
import { ProgressBar } from '../components/ProgressBar';
import { formatDuration } from '../utils/format';
import { useTheme } from '../theme';
import { useSettingsStore } from '../store/settingsStore';
import { netStatus } from '../services/netStatus';

export const PlayerScreen = () => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const track = useActiveTrack();
  const playback = usePlaybackState();
  const progress = useProgress();
  const quality = useSettingsStore((s) => s.quality);
  const playlistVisible = useUIStore(state => state.playlistVisible);

  const isPlaying = playback.state === State.Playing;
  const isBuffering = playback.state === State.Buffering || playback.state === State.Loading;

  if (!track) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.background }}>
        <Text style={{ color: t.colors.textSub }}>未播放</Text>
      </View>
    );
  }

  const isLocal = String(track.url || '').startsWith('file://');
  const qualityText = { low: '64K', medium: '132K', high: '192K' }[quality];
  const sourceText = isLocal ? '本地缓存' : netStatus.type === 'wifi' ? 'WiFi' : '移动数据';

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background, paddingTop: insets.top },
    header: {
      height: 48, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: t.spacing.sm, justifyContent: 'space-between',
    },
    body: { flex: 1, alignItems: 'center', paddingHorizontal: t.spacing.xl },
    cover: {
      width: 280, height: 280, borderRadius: t.radius.xl,
      marginTop: t.spacing.xl,
      shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 }, elevation: 12,
    },
    title: {
      fontSize: t.fontSize.xxl, fontWeight: 'bold', color: t.colors.text,
      textAlign: 'center', marginTop: t.spacing.xxl,
    },
    artist: {
      fontSize: t.fontSize.base, color: t.colors.textSub,
      textAlign: 'center', marginTop: t.spacing.xs,
    },
    progressBox: { width: '100%', marginTop: t.spacing.xxl },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
    time: { fontSize: t.fontSize.xs, color: t.colors.textHint },
    controls: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
      width: '100%', marginTop: t.spacing.xxl,
    },
    playBtn: {
      width: 64, height: 64, borderRadius: 32,
      backgroundColor: t.colors.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    statusBar: {
      flexDirection: 'row', justifyContent: 'center',
      paddingBottom: insets.bottom + t.spacing.lg,
      gap: t.spacing.lg,
    },
    statusItem: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    statusText: { fontSize: t.fontSize.xs, color: t.colors.textHint },
  });

  const onSeekEnd = (p: number) => {
    TrackPlayer.seekTo(p * progress.duration);
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} />
      <View style={s.header}>
        <IconButton name="chevron-down" size={28} onPress={() => nav.goBack()} />
        <IconButton name="playlist-music" size={24} color={t.colors.text}
          onPress={() => useUIStore.getState().setPlaylistVisible(true)} />
      </View>

      <View style={s.body}>
        <FastImage source={{ uri: track.artwork as string }} style={s.cover} />
        <Text style={s.title} numberOfLines={2}>{track.title}</Text>
        <Text style={s.artist} numberOfLines={1}>{track.artist}</Text>

        <View style={s.progressBox}>
          <ProgressBar
            progress={progress.duration > 0 ? progress.position / progress.duration : 0}
            onSeekEnd={onSeekEnd}
          />
          <View style={s.timeRow}>
            <Text style={s.time}>{formatDuration(progress.position)}</Text>
            <Text style={s.time}>{formatDuration(progress.duration)}</Text>
          </View>
        </View>

        <View style={s.controls}>
          <IconButton name="skip-previous" size={36} onPress={() => TrackPlayer.skipToPrevious()} />
          <View style={s.playBtn}>
            <IconButton
              name={isPlaying ? 'pause' : 'play'}
              size={32}
              color="#fff"
              onPress={() => (isPlaying ? TrackPlayer.pause() : TrackPlayer.play())}
            />
          </View>
          <IconButton name="skip-next" size={36} onPress={() => TrackPlayer.skipToNext()} />
        </View>

        {isBuffering && (
          <Text style={[s.time, { marginTop: 8 }]}>缓冲中...</Text>
        )}
      </View>

      <View style={s.statusBar}>
        <View style={s.statusItem}>
          <Text style={s.statusText}>音质 {qualityText}</Text>
        </View>
        <View style={s.statusItem}>
          <Text style={s.statusText}>·    来源 {sourceText}</Text>
        </View>
        {/* Playlist Panel Modal */}
        <PlaylistPanel visible={playlistVisible} onClose={() => useUIStore.getState().setPlaylistVisible(false)} />
      </View>
    </View>
  );
};
