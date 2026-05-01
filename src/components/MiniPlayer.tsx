import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import FastImage from 'react-native-fast-image';
import TrackPlayer, {
  useActiveTrack, usePlaybackState, useProgress, State,
} from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { IconButton } from './IconButton';
import { useTheme } from '../theme';

export const MiniPlayer: React.FC = () => {
  const t = useTheme();
  const track = useActiveTrack();
  const playback = usePlaybackState();
  const progress = useProgress();
  const nav = useNavigation<any>();

  if (!track) return null;
  const isPlaying = playback.state === State.Playing;
  const p = progress.duration > 0 ? progress.position / progress.duration : 0;

  const s = StyleSheet.create({
    wrap: {
      backgroundColor: t.colors.surface,
      borderTopWidth: t.isDark ? 0 : 0.5,
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

  return (
    <View style={s.wrap}>
      <View style={s.progress}>
        <View style={[s.progressFill, { width: `${p * 100}%` }]} />
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
          <IconButton
            name={isPlaying ? 'pause' : 'play'}
            size={26}
            color={t.colors.text}
            onPress={() => (isPlaying ? TrackPlayer.pause() : TrackPlayer.play())}
          />
          <IconButton name="skip-next" size={26} color={t.colors.text}
                      onPress={() => TrackPlayer.skipToNext()} />
        </View>
      </View>
    </View>
  );
};
