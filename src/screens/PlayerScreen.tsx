import React, { useState } from 'react';
import { View, Text, StyleSheet, StatusBar, ScrollView, TouchableOpacity, Image, ActivityIndicator, Modal, TouchableWithoutFeedback, Platform } from 'react-native';
import FastImage from 'react-native-fast-image';
import TrackPlayer, { useActiveTrack, usePlaybackState, State } from 'react-native-track-player';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton } from '../components/IconButton';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useUIStore } from '../store/uiStore';
// import { PlaylistPanel } from '../components/PlaylistPanel'; // removed to avoid duplicate modal rendering
import { ProgressBar } from '../components/ProgressBar';
import { MarqueeText } from '../components/MarqueeText';
import { formatDuration } from '../utils/format';
import { useTheme } from '../theme';
import { useSettingsStore } from '../store/settingsStore';
import { netStatus } from '../services/netStatus';
import { usePlayerStore } from '../store/playerStore';
import { playSpecificPart } from '../services/trackPlayer';
import { useSyncStore } from '../store/syncStore';
import { useProgressStore } from '../store/progressStore';

export const PlayerScreen = () => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const track = useActiveTrack();
  const playback = usePlaybackState();
  // 【性能修复】选择性子订阅 progressStore，避免每次进度轮询都触发全组件重渲染
  const progressPosition = useProgressStore((s) => s.position);
  const progressDuration = useProgressStore((s) => s.duration);
  const progressBuffered = useProgressStore((s) => s.buffered);
  const quality = useSettingsStore((s) => s.quality);
  // const playlistVisible = useUIStore(state => state.playlistVisible); // removed, handled globally
  // 性能优化：订阅当前正在播放的视频而非整个 queue 数组，
  // 避免切换播放模式（shuffle/sequential）时整个播放器界面重渲染
  const trackId = track?.id;
  const currentVideo = usePlayerStore(
    (s) => trackId ? s.queue.find((v) => v.bvid === trackId) : undefined
  );
  const currentCid = usePlayerStore((s) => s.currentCid);
  const isResolving = usePlayerStore((s) => s.isResolving);
  const playMode = usePlayerStore((s) => s.playMode);
  const togglePlayMode = usePlayerStore((s) => s.togglePlayMode);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const [isPartsModalVisible, setIsPartsModalVisible] = useState(false);

  const isPlaying = playback.state === State.Playing;
  const isBuffering = playback.state === State.Buffering || playback.state === State.Loading;
  const isGlass = !!t.glass;

  const statusBarHeight = Platform.OS === 'android' ? Math.max(insets.top, StatusBar.currentHeight ?? 0) : insets.top;

  if (!track) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.colors.background }}>
        <Text style={{ color: t.colors.textSub }}>未播放</Text>
      </View>
    );
  }

  const hasMultiParts = currentVideo?.parts && currentVideo.parts.length > 1;
  const currentPart = currentVideo?.parts?.find((p) => p.cid === currentCid);

  const isLocal = String(track.url || '').startsWith('file://');
  const qualityText = { low: '64K', medium: '132K', high: '192K', dolby: '杜比全景声', hires: 'Hi-Res' }[quality];
  const sourceText = isLocal ? '本地缓存' : netStatus.type === 'wifi' ? 'WiFi' : '移动数据';

  // 玻璃主题专用颜色
  const g = t.glass;
  const textPrimary = isGlass ? g!.colors.text.primary : t.colors.text;
  const textSecondary = isGlass ? g!.colors.text.secondary : t.colors.textSub;
  const textTertiary = isGlass ? g!.colors.text.tertiary : t.colors.textHint;
  const accentPrimary = isGlass ? g!.colors.accent.primary : t.colors.primary;
  const surfaceBg = isGlass ? g!.colors.glass.bg : t.colors.surface;
  const dividerColor = t.colors.divider;
  const blurRadius = isGlass ? g!.material.blurRadius : 0;
  const playBg = isGlass
    ? typeof g!.colors.button.playBg === 'string'
      ? g!.colors.button.playBg
      : g!.colors.button.playBg[0]
    : t.colors.primary;
  const playTextColor = isGlass ? g!.colors.button.playText : '#fff';

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    header: {
      height: 64,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: t.spacing.xl,
      justifyContent: 'space-between',
      marginTop: t.spacing.md + statusBarHeight,
    },
    headerTextContainer: {
      flex: 1,
      marginRight: t.spacing.lg,
      overflow: 'hidden',
    },
    headerTitle: { fontSize: t.fontSize.xxl, fontWeight: 'bold', color: textPrimary },
    headerArtist: { fontSize: t.fontSize.sm, color: textSecondary, marginTop: 2 },
    body: { flex: 1 },
    cover: { width: 320, height: 320, borderRadius: t.radius.xl, marginTop: t.spacing.xxl + 40, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
    progressBox: { width: '100%', marginTop: t.spacing.xxl + 50 },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
    time: { fontSize: t.fontSize.xs, color: textTertiary },
    controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', width: '100%', marginTop: t.spacing.xxl },
    playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: playBg, alignItems: 'center', justifyContent: 'center' },
    bottomBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', width: '100%', marginTop: t.spacing.xxl, paddingHorizontal: t.spacing.xl, paddingBottom: insets.bottom + t.spacing.xl },
    bottomBarLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.spacing.lg },
    statusBar: { flexDirection: 'row', justifyContent: 'center', paddingBottom: insets.bottom + t.spacing.lg, gap: t.spacing.lg },
    statusItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    statusText: { fontSize: t.fontSize.xs, color: textTertiary },
    partsContainer: { alignSelf: 'stretch', marginTop: t.spacing.md },
    partsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, backgroundColor: surfaceBg, borderRadius: t.radius.md },
    partsHeaderText: { fontSize: t.fontSize.base, color: textPrimary, fontWeight: '500' },
    partsList: { maxHeight: 250, marginTop: 4, borderRadius: t.radius.md, backgroundColor: surfaceBg },
    partItem: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dividerColor },
    partItemActive: { backgroundColor: accentPrimary + '20' },
    partItemContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    partItemText: { fontSize: t.fontSize.sm, color: textPrimary, flex: 1, marginRight: 8 },
    partItemTextActive: { color: accentPrimary, fontWeight: '600' },
    playingIndicator: { fontSize: t.fontSize.xs, color: accentPrimary },
    modalOverlay: { flex: 1, justifyContent: 'flex-end' },
    modalBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    modalContent: { backgroundColor: surfaceBg, borderTopLeftRadius: t.radius.xl, borderTopRightRadius: t.radius.xl, maxHeight: '60%', paddingBottom: insets.bottom },
    modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: t.spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dividerColor },
    modalTitle: { fontSize: t.fontSize.lg, fontWeight: 'bold', color: textPrimary },
    modalScroll: { paddingHorizontal: t.spacing.md },
    modalPartItem: { paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: dividerColor },
    modalPartItemActive: { backgroundColor: accentPrimary + '20', borderRadius: t.radius.md },
    blurBackground: { ...StyleSheet.absoluteFillObject, zIndex: 0 },
    blurOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: isGlass ? g!.colors.glass.bg : 'transparent', zIndex: 1 },
    contentLayer: { flex: 1, zIndex: 2 },
  });

  const onSeekEnd = (p: number) => {
    TrackPlayer.seekTo(p * progressDuration);
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      {isGlass && track.artwork ? (
        <>
          <Image source={{ uri: track.artwork as string }} style={s.blurBackground} blurRadius={blurRadius} resizeMode="cover" />
          <View style={s.blurOverlay} pointerEvents="none" />
        </>
      ) : null}
      <View style={s.contentLayer}>
        <View style={s.header}>
          <View style={s.headerTextContainer}>
            <MarqueeText text={track.title || '未知歌曲'} style={s.headerTitle} />
            <Text style={s.headerArtist} numberOfLines={1}>
              {track.artist || '未知歌手'}
            </Text>
          </View>
          <IconButton name="chevron-down" size={28} color={isGlass ? textPrimary : t.colors.text} onPress={() => nav.goBack()} />
        </View>
        <View style={[s.body, { alignItems: 'center', paddingHorizontal: t.spacing.xl }]}>
          <FastImage source={{ uri: track.artwork as string }} style={s.cover} />
          <View style={s.progressBox}>
            <ProgressBar progress={progressDuration > 0 ? progressPosition / progressDuration : 0} onSeekEnd={onSeekEnd} />
            <View style={s.timeRow}>
              <Text style={s.time}>{formatDuration(progressPosition)}</Text>
              <Text style={s.time}>{formatDuration(progressDuration)}</Text>
            </View>
          </View>
          <View style={s.controls}>
            <IconButton name="skip-previous" size={36} color={isGlass ? textPrimary : t.colors.text} onPress={() => TrackPlayer.skipToPrevious()} />
            <View style={s.playBtn}>
              {(isBuffering || isResolving) ? (
                <ActivityIndicator size="large" color={playTextColor} />
              ) : (
                <IconButton name={isPlaying ? 'pause' : 'play'} size={32} color={playTextColor} onPress={() => (isPlaying ? TrackPlayer.pause() : TrackPlayer.play())} />
              )}
            </View>
            <IconButton name="skip-next" size={36} color={isGlass ? textPrimary : t.colors.text} onPress={() => TrackPlayer.skipToNext()} />
          </View>
          <View style={s.bottomBar}>
            <IconButton name="playlist-music" size={24} color={isGlass ? textPrimary : t.colors.text} onPress={() => useUIStore.getState().setPlaylistVisible(true)} />
            <IconButton
              name="tune"
              size={24}
              color={isGlass ? textPrimary : t.colors.text}
              onPress={() => nav.navigate('SoundLab')}
            />
            <IconButton
              name={playMode === 'shuffle' ? 'shuffle' : 'repeat'}
              size={24}
              color={isGlass ? textPrimary : t.colors.text}
              onPress={togglePlayMode}
              disabled={syncStatus === 'syncing'}
            />
            {hasMultiParts && (
              <IconButton
                name="format-list-numbered"
                size={24}
                color={isGlass ? textPrimary : t.colors.text}
                onPress={() => setIsPartsModalVisible(true)}
              />
            )}
          </View>
        </View>
      </View>

      {hasMultiParts && currentVideo && (
        <Modal
          visible={isPartsModalVisible}
          transparent={true}
          animationType="slide"
          onRequestClose={() => setIsPartsModalVisible(false)}
        >
          <View style={s.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => setIsPartsModalVisible(false)}>
              <View style={s.modalBackground} />
            </TouchableWithoutFeedback>
            <View style={s.modalContent}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>选集 ({currentVideo.parts!.length})</Text>
                <IconButton name="close" size={24} color={textPrimary} onPress={() => setIsPartsModalVisible(false)} />
              </View>
              <ScrollView style={s.modalScroll} showsVerticalScrollIndicator={false}>
                {currentVideo.parts!.map((part) => {
                  const isActive = part.cid === currentCid;
                  return (
                    <TouchableOpacity
                      key={part.cid}
                      style={[s.modalPartItem, isActive && s.modalPartItemActive]}
                      onPress={() => {
                        playSpecificPart(currentVideo.bvid, part.cid, part.title);
                        setIsPartsModalVisible(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={s.partItemContent}>
                        <Text style={[s.partItemText, isActive && s.partItemTextActive]} numberOfLines={1}>
                          {part.title}
                        </Text>
                        {isActive && <Text style={s.playingIndicator}>▶</Text>}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
};
