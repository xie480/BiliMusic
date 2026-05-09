import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { View, Text, StyleSheet, StatusBar, ScrollView, TouchableOpacity, Image, ActivityIndicator, Modal, TouchableWithoutFeedback, Platform, Animated, InteractionManager } from 'react-native';
import FastImage from 'react-native-fast-image';
import TrackPlayer, { useActiveTrack, usePlaybackState, State } from 'react-native-track-player';
import { resumePlayback, playSpecificPart } from '../services/trackPlayer';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
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
import { useSyncStore } from '../store/syncStore';
import { useProgressStore } from '../store/progressStore';

// ======== 【性能优化】静态样式移至组件外部，避免每次渲染重复创建 ========
const STATIC_STYLES = StyleSheet.create({
  container: { flex: 1 },
  header: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    justifyContent: 'space-between',
  },
  headerTextContainer: {
    flex: 1,
    marginRight: 16,
    overflow: 'hidden',
  },
  body: { flex: 1 },
  cover: {
    width: 320,
    height: 320,
    borderRadius: 16,
    marginTop: 70,
    marginBottom: -10,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  progressBox: { width: '100%', marginTop: 90 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -2 },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 32,
  },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 32,
    paddingHorizontal: 16,
  },
  bottomBarLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 16 },
  statusBar: { flexDirection: 'row', justifyContent: 'center', gap: 16 },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  partsContainer: { alignSelf: 'stretch', marginTop: 8 },
  partsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  partsList: { maxHeight: 250, marginTop: 4, borderRadius: 8 },
  partItem: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  partItemContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  partItemText: { fontSize: 14, flex: 1, marginRight: 8 },
  playingIndicator: { fontSize: 12 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackground: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  modalContent: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '60%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: 18, fontWeight: 'bold' },
  modalScroll: { paddingHorizontal: 12 },
  modalPartItem: {
    paddingHorizontal: 12,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  blurBackground: { ...StyleSheet.absoluteFillObject, zIndex: 0 },
  blurOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 1 },
  contentLayer: { flex: 1, zIndex: 2 },
});

export const PlayerScreen = () => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();

  // ======== 【防闪烁修复 v3】仅选取原始数据，避免在 selector 中创建新对象导致无限循环 ========
  // 【问题】之前的写法在 selector 内每次执行都创建新的 fallbackTrack 对象，
  // useShallow 浅比较发现引用变化 → 触发重渲染 → 再次创建 → 无限循环（getSnapshot should be cached）
  // 【修复】仅选取 queue/currentBvid 等原始引用，用 useMemo 缓存 fallbackTrack 计算结果
  const {
    storeQueue,
    storeCurrentBvid,
    currentCid,
    isResolving,
    playMode,
    togglePlayMode,
  } = usePlayerStore(
    useShallow((s) => ({
      storeQueue: s.queue,
      storeCurrentBvid: s.currentBvid,
      currentCid: s.currentCid,
      isResolving: s.isResolving,
      playMode: s.playMode,
      togglePlayMode: s.togglePlayMode,
    }))
  );

  // ======== 用 useMemo 缓存 fallbackTrack，避免每次渲染重新创建对象 ========
  const { fallbackTrack, fallbackDuration } = useMemo(() => {
    const currVideo = storeQueue.find((v) => v.bvid === storeCurrentBvid);
    return {
      fallbackTrack: currVideo
        ? {
            id: currVideo.bvid,
            title: currVideo.title,
            artist: currVideo.upper?.name || '未知歌手',
            artwork: currVideo.cover,
            duration: currVideo.duration,
          }
        : null,
      fallbackDuration: currVideo?.duration ?? 0,
    };
  }, [storeQueue, storeCurrentBvid]);

  // ======== 【防闪烁优化】合并 progressStore 订阅 ========
  const { progressPosition, progressDuration } = useProgressStore(
    useShallow((s) => ({ progressPosition: s.position, progressDuration: s.duration }))
  );

  const quality = useSettingsStore((s) => s.quality);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const activeTrack = useActiveTrack();
  const playback = usePlaybackState();
  const [isPartsModalVisible, setIsPartsModalVisible] = useState(false);

  /**
   * 【防闪烁修复 v2】轨道来源优先级策略
   *
   * 核心问题：VideosScreen 调用 navigation.navigate('Player') 时，TrackPlayer 尚未被
   * loadQueue 重置（延迟到 InteractionManager.runAfterInteractions），导致
   * useActiveTrack() 仍然返回上一首歌曲的轨道数据，造成 PlayerScreen 挂载时短暂闪烁旧界面。
   *
   * 修复策略：
   * - 当 isResolving=true（正在切换/加载）且活跃轨道 BVID 与目标 BVID 不一致时 → 优先使用
   *   fallbackTrack（来自 setQueue 的新数据），彻底避免旧数据泄露。
   * - 当 isResolving=false 或 BVID 已一致时 → 使用 useActiveTrack()（TrackPlayer 已就绪）
   */
  const track =
    isResolving && activeTrack?.id !== storeCurrentBvid
      ? ((fallbackTrack as any) || null)
      : (activeTrack || (fallbackTrack as any) || null);

  // ======== 从 track 计算 currentVideo（替代旧的独立 selector） ========
  const trackId = track?.id;
  const currentVideo = usePlayerStore(
    useShallow((s) => (trackId ? s.queue.find((v) => v.bvid === trackId) : undefined))
  );

  const duration = progressDuration || fallbackDuration;

  const isPlaying = playback.state === State.Playing;
  // ======== 加载状态判定 ========
  const trackUrl = track?.url;
  const isPlaceholder = typeof trackUrl === 'string' && trackUrl.startsWith('placeholder://');
  const isBuffering = !isPlaceholder && (playback.state === State.Buffering || playback.state === State.Loading);
  const isGlass = !!t.glass;

  const statusBarHeight = Platform.OS === 'android' ? Math.max(insets.top, StatusBar.currentHeight ?? 0) : insets.top;


  // ======== 【防闪烁修复】useFocusEffect：页面聚焦时重置 progressStore ========
  const hasResetProgressOnFocus = useRef(false);
  useFocusEffect(
    React.useCallback(() => {
      if (!hasResetProgressOnFocus.current) {
        if (isResolving) {
          useProgressStore.getState().resetProgress();
        }
        hasResetProgressOnFocus.current = true;
      }
      return () => {
        hasResetProgressOnFocus.current = false;
      };
    }, [isResolving])
  );

  // ======== 【性能优化】使用 useMemo 缓存主题派生值，避免每次渲染重新计算 ========
  const themeColors = useMemo(() => {
    const g = t.glass;
    if (!g) {
      return {
        textPrimary: t.colors.text,
        textSecondary: t.colors.textSub,
        textTertiary: t.colors.textHint,
        accentPrimary: t.colors.primary,
        surfaceBg: t.colors.surface,
        dividerColor: t.colors.divider,
        blurRadius: 0,
        playBg: t.colors.primary,
        playTextColor: '#fff',
        headerMarginTop: t.spacing.md + statusBarHeight,
        bottomPadding: insets.bottom + 16,
        modalBottomPadding: insets.bottom,
      };
    }
    return {
      textPrimary: g.colors.text.primary,
      textSecondary: g.colors.text.secondary,
      textTertiary: g.colors.text.tertiary,
      accentPrimary: g.colors.accent.primary,
      surfaceBg: g.colors.glass.bg,
      dividerColor: t.colors.divider,
      blurRadius: g.material.blurRadius,
      playBg: typeof g.colors.button.playBg === 'string'
        ? g.colors.button.playBg
        : g.colors.button.playBg[0],
      playTextColor: g.colors.button.playText,
      headerMarginTop: t.spacing.md + statusBarHeight,
      bottomPadding: insets.bottom + 16,
      modalBottomPadding: insets.bottom,
    };
  }, [t, statusBarHeight, insets.bottom]);

  // ======== 【性能优化】使用 useMemo 缓存动态样式 ========
  const dynamicStyles = useMemo(() => StyleSheet.create({
    header: {
      ...STATIC_STYLES.header,
      marginTop: themeColors.headerMarginTop,
    },
    headerTitle: { fontSize: t.fontSize.xxl, fontWeight: 'bold', color: themeColors.textPrimary },
    headerArtist: { fontSize: t.fontSize.sm, color: themeColors.textSecondary, marginTop: 2 },
    cover: {
      ...STATIC_STYLES.cover,
    },
    progressBox: {
      ...STATIC_STYLES.progressBox,
      marginTop: t.spacing.xxl + 50,
    },
    time: { fontSize: t.fontSize.xs, color: themeColors.textTertiary },
    playBtn: {
      ...STATIC_STYLES.playBtn,
      backgroundColor: themeColors.playBg,
    },
    bottomBar: {
      ...STATIC_STYLES.bottomBar,
      paddingBottom: themeColors.bottomPadding,
    },
    statusBar: {
      ...STATIC_STYLES.statusBar,
      paddingBottom: themeColors.modalBottomPadding + 16,
    },
    statusText: { fontSize: t.fontSize.xs, color: themeColors.textTertiary },
    partsHeader: {
      ...STATIC_STYLES.partsHeader,
      backgroundColor: themeColors.surfaceBg,
    },
    partsHeaderText: { fontSize: t.fontSize.base, color: themeColors.textPrimary, fontWeight: '500' },
    partsList: {
      ...STATIC_STYLES.partsList,
      backgroundColor: themeColors.surfaceBg,
    },
    partItem: {
      ...STATIC_STYLES.partItem,
      borderBottomColor: themeColors.dividerColor,
    },
    partItemActive: { backgroundColor: themeColors.accentPrimary + '20' },
    partItemText: { ...STATIC_STYLES.partItemText, color: themeColors.textPrimary },
    partItemTextActive: { color: themeColors.accentPrimary, fontWeight: '600' },
    modalContent: {
      ...STATIC_STYLES.modalContent,
      backgroundColor: themeColors.surfaceBg,
      paddingBottom: themeColors.modalBottomPadding,
    },
    modalHeader: {
      ...STATIC_STYLES.modalHeader,
      borderBottomColor: themeColors.dividerColor,
    },
    modalTitle: { ...STATIC_STYLES.modalTitle, color: themeColors.textPrimary },
    modalPartItem: {
      ...STATIC_STYLES.modalPartItem,
      borderBottomColor: themeColors.dividerColor,
    },
    modalPartItemActive: { backgroundColor: themeColors.accentPrimary + '20', borderRadius: 8 },
    loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    blurOverlay: {
      ...STATIC_STYLES.blurOverlay,
      backgroundColor: isGlass ? themeColors.surfaceBg : 'transparent',
    },
  }), [t, themeColors, isGlass]);

  if (!track) {
    return (
      <View style={[{ backgroundColor: t.colors.background }, dynamicStyles.loadingContainer]}>
        <ActivityIndicator size="large" color={t.colors.primary} />
      </View>
    );
  }

  const hasMultiParts = currentVideo?.parts && currentVideo.parts.length > 1;

  const [dragPosition, setDragPosition] = useState<number | null>(null);

  const onSeekStart = () => {
    setDragPosition(progressPosition);
  };

  const onSeekUpdate = (p: number) => {
    setDragPosition(p * progressDuration);
  };

  const onSeekEnd = (p: number) => {
    setDragPosition(null);
    TrackPlayer.seekTo(p * progressDuration);
  };

  return (
    <View style={[STATIC_STYLES.container, { backgroundColor: t.colors.background }]}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      {isGlass && track.artwork ? (
        <>
          <Image source={{ uri: track.artwork as string }} style={STATIC_STYLES.blurBackground} blurRadius={themeColors.blurRadius} resizeMode="cover" />
          <View style={dynamicStyles.blurOverlay} pointerEvents="none" />
        </>
      ) : null}
      <View style={STATIC_STYLES.contentLayer}>
        <View style={dynamicStyles.header}>
          <View style={STATIC_STYLES.headerTextContainer}>
            <MarqueeText text={track.title || '未知歌曲'} style={dynamicStyles.headerTitle} />
            <Text style={dynamicStyles.headerArtist} numberOfLines={1}>
              {track.artist || '未知歌手'}
            </Text>
          </View>
          <IconButton name="chevron-down" size={28} color={isGlass ? themeColors.textPrimary : t.colors.text} onPress={() => nav.goBack()} />
        </View>
        <View style={[STATIC_STYLES.body, { alignItems: 'center', paddingHorizontal: t.spacing.xl }]}>
          <FastImage source={{ uri: track.artwork as string }} style={dynamicStyles.cover} />
          <View style={dynamicStyles.progressBox}>
            <ProgressBar
              progress={progressDuration > 0 ? progressPosition / progressDuration : 0}
              onSeekStart={onSeekStart}
              onSeekUpdate={onSeekUpdate}
              onSeekEnd={onSeekEnd}
            />
            <View style={STATIC_STYLES.timeRow}>
              <Text style={dynamicStyles.time}>{formatDuration(dragPosition !== null ? dragPosition : progressPosition)}</Text>
              <Text style={dynamicStyles.time}>{formatDuration(progressDuration)}</Text>
            </View>
          </View>
          <View style={STATIC_STYLES.controls}>
            <IconButton name="skip-previous" size={36} color={isGlass ? themeColors.textPrimary : t.colors.text} onPress={async () => { await TrackPlayer.skipToPrevious(); await TrackPlayer.play(); }} />
            <View style={dynamicStyles.playBtn}>
              {(isBuffering || isResolving) ? (
                <ActivityIndicator size="large" color={themeColors.playTextColor} />
              ) : (
                <IconButton name={isPlaying ? 'pause' : 'play'} size={32} color={themeColors.playTextColor} onPress={() => (isPlaying ? TrackPlayer.pause() : resumePlayback())} />
              )}
            </View>
            <IconButton name="skip-next" size={36} color={isGlass ? themeColors.textPrimary : t.colors.text} onPress={async () => { await TrackPlayer.skipToNext(); await TrackPlayer.play(); }} />
          </View>
          <View style={dynamicStyles.bottomBar}>
            <IconButton name="playlist-music" size={24} color={isGlass ? themeColors.textPrimary : t.colors.text} onPress={() => useUIStore.getState().setPlaylistVisible(true)} />
            <IconButton
              name="tune"
              size={24}
              color={isGlass ? themeColors.textPrimary : t.colors.text}
              onPress={() => nav.navigate('SoundLab')}
            />
            <IconButton
              name={playMode === 'shuffle' ? 'shuffle' : 'repeat'}
              size={24}
              color={isGlass ? themeColors.textPrimary : t.colors.text}
              onPress={togglePlayMode}
              disabled={syncStatus === 'syncing'}
            />
            {hasMultiParts && (
              <IconButton
                name="format-list-numbered"
                size={24}
                color={isGlass ? themeColors.textPrimary : t.colors.text}
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
          <View style={STATIC_STYLES.modalOverlay}>
            <TouchableWithoutFeedback onPress={() => setIsPartsModalVisible(false)}>
              <View style={STATIC_STYLES.modalBackground} />
            </TouchableWithoutFeedback>
            <View style={dynamicStyles.modalContent}>
              <View style={dynamicStyles.modalHeader}>
                <Text style={dynamicStyles.modalTitle}>选集 ({currentVideo.parts!.length})</Text>
                <IconButton name="close" size={24} color={themeColors.textPrimary} onPress={() => setIsPartsModalVisible(false)} />
              </View>
              <ScrollView style={STATIC_STYLES.modalScroll} showsVerticalScrollIndicator={false}>
                {currentVideo.parts!.map((part: any) => {
                  const isActive = part.cid === currentCid;
                  return (
                    <TouchableOpacity
                      key={part.cid}
                      style={[dynamicStyles.modalPartItem, isActive && dynamicStyles.modalPartItemActive]}
                      onPress={() => {
                        playSpecificPart(currentVideo.bvid, part.cid, part.title);
                        setIsPartsModalVisible(false);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={STATIC_STYLES.partItemContent}>
                        <Text style={[dynamicStyles.partItemText, isActive && dynamicStyles.partItemTextActive]} numberOfLines={1}>
                          {part.title}
                        </Text>
                        {isActive && <Text style={[STATIC_STYLES.playingIndicator, { color: themeColors.accentPrimary }]}>▶</Text>}
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
