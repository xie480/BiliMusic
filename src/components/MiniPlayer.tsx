import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import FastImage from 'react-native-fast-image';
import TrackPlayer, {
  useActiveTrack, usePlaybackState, State,
} from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { IconButton } from './IconButton';
import { GlassView } from './GlassView';
import { useTheme } from '../theme';
import { useUIStore } from '../store/uiStore';
import { usePlayerStore } from '../store/playerStore';
import { useProgressStore } from '../store/progressStore';

export const MiniPlayer: React.FC = () => {
  const t = useTheme();
  const track = useActiveTrack();
  const playback = usePlaybackState();
  // 【性能修复】选择性子订阅，避免每次进度轮询触发重渲染
  const progressPosition = useProgressStore((s) => s.position);
  const progressDuration = useProgressStore((s) => s.duration);
  const nav = useNavigation<any>();
  const isGlass = !!t.glass;
  const isResolving = usePlayerStore((s) => s.isResolving);

  if (!track) return null;
  const isPlaying = playback.state === State.Playing;
  const isBufferingOrResolving = playback.state === State.Buffering || playback.state === State.Loading || isResolving;
  const p = progressDuration > 0 ? progressPosition / progressDuration : 0;

  const s = StyleSheet.create({
    wrap: {
      borderTopWidth: isGlass ? 0 : (t.isDark ? 0 : 0.5),
      borderTopColor: t.colors.divider,
      shadowColor: '#000', shadowOpacity: 0.08,
      shadowRadius: 12, shadowOffset: { width: 0, height: -2 },
      elevation: 6,
    },
    progress: {
      height: 2, backgroundColor: t.colors.divider,
    },
    progressFill: {
      height: 2, backgroundColor: t.colors.primary,
    },
    row: {
      flexDirection: 'row', alignItems: 'center',
      paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.md,
      height: 56,
    },
    cover: { width: 40, height: 40, borderRadius: t.radius.sm },
    info: { flex: 1, marginHorizontal: t.spacing.md },
    title: { fontSize: t.fontSize.base, color: t.colors.text, fontWeight: '500' },
    artist: { fontSize: t.fontSize.xs, color: t.colors.textSub, marginTop: 2 },
    actions: { flexDirection: 'row', alignItems: 'center' },
  });

  const innerContent = (
    <>
      <View style={s.progress}>
        {isGlass && t.glass && t.glass.colors.progress.fill ? (
          <LinearGradient
            colors={t.glass.colors.progress.fill}
            start={{x:0,y:0}} end={{x:1,y:0}}
            style={[s.progressFill, { width: `${p * 100}%` }]}
          />
        ) : (
          <View style={[s.progressFill, { width: `${p * 100}%` }]} />
        )}
      </View>
      <View style={s.row}>
        <TouchableOpacity onPress={() => nav.navigate('Player')} activeOpacity={0.7}>
          <FastImage source={{ uri: track.artwork as string }} style={s.cover} />
        </TouchableOpacity>
        <TouchableOpacity
          style={s.info}
          activeOpacity={0.7}
          onPress={() => nav.navigate('Player')}
        >
          <Text style={s.title} numberOfLines={1}>{track.title}</Text>
          <Text style={s.artist} numberOfLines={1}>{track.artist}</Text>
        </TouchableOpacity>
        <View style={s.actions}>
          {isBufferingOrResolving ? (
            <ActivityIndicator size="small" color={t.colors.primary} style={{ marginRight: 12 }} />
          ) : (
            <IconButton
              name={isPlaying ? 'pause' : 'play'}
              size={26}
              color={t.colors.text}
              onPress={() => (isPlaying ? TrackPlayer.pause() : TrackPlayer.play())}
            />
          )}
          <IconButton name="skip-next" size={26} color={t.colors.text}
                      onPress={async () => { await TrackPlayer.skipToNext(); await TrackPlayer.play(); }} />
          <IconButton name="playlist-music" size={24} color={t.colors.text}
                      onPress={() => useUIStore.getState().setPlaylistVisible(true)} />
        </View>
      </View>
    </>
  );

  if (isGlass) {
    return (
      <GlassView style={s.wrap} borderRadius={0}>
        {innerContent}
      </GlassView>
    );
  }

  return <View style={[s.wrap, { backgroundColor: t.colors.surface }]}>{innerContent}</View>;
};
