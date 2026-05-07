// src/components/PlaylistPanel.tsx (refactored)
import React, { useCallback, memo, useState, useRef } from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity as RNTouchableOpacity, FlatList, ListRenderItemInfo } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme';
import { GlassView } from './GlassView';
import { usePlayerStore } from '../store/playerStore';
import { IconButton } from './IconButton';
import type { FavoriteVideo } from '../types/domain';
import { formatDuration } from '../utils/format';
import { playSpecificPart } from '../services/trackPlayer';
import { useFolderDataStore } from '../store/folderDataStore';
import { useSyncStore } from '../store/syncStore';

/**
 * 全局播放列表面板，支持当前播放高亮、自动定位。
 * 通过 Zustand playerStore 与原生 TrackPlayer 同步。
 */
export const PlaylistPanel = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const t = useTheme();
  const queue = usePlayerStore((s) => s.queue);
  const currentBvid = usePlayerStore((s) => s.currentBvid);
  const playContext = usePlayerStore((s) => s.playContext);
  const appendQueue = usePlayerStore((s) => s.appendQueue);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const playMode = usePlayerStore((s) => s.playMode);
  const togglePlayMode = usePlayerStore((s) => s.togglePlayMode);
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const [expandedBvid, setExpandedBvid] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listRef = useRef<any>(null);

  const initialIndex = React.useMemo(() => {
    if (currentBvid && queue.length > 0) {
      const idx = queue.findIndex((v) => v.bvid === currentBvid);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  }, [currentBvid, queue]);

  // 点击歌曲条目：立即跳转播放
  const handlePress = useCallback(async (bvid: string) => {
    const q = usePlayerStore.getState().queue;
    const idx = q.findIndex((v) => v.bvid === bvid);
    if (idx !== -1) {
      await TrackPlayer.skip(idx);
      TrackPlayer.play();
      usePlayerStore.getState().setCurrentBvid(bvid);
      onClose();
    }
  }, [onClose]);

  const PlaylistItem = memo(({
    item,
    onPlay,
    isExpanded,
    onPartPress,
    onExpandToggle,
    isCurrent,
    primaryColor,
  }: {
    item: FavoriteVideo;
    onPlay: () => void;
    isExpanded: boolean;
    onPartPress: (cid: number, partTitle: string) => void;
    onExpandToggle: () => void;
    isCurrent: boolean;
    primaryColor: string;
  }) => (
    <View>
      <View style={[styles.item, { backgroundColor: isCurrent ? t.colors.primaryLight : t.colors.surface }]}> 
        {/* 信息区 - 点击播放歌曲 */}
        <RNTouchableOpacity style={styles.infoTouchable} onPress={onPlay} activeOpacity={0.6}>
          <View style={styles.info}>
            <Text
              style={[{ color: t.colors.text }, styles.title, isCurrent && { color: primaryColor, fontWeight: '700' }]} 
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item.title}
            </Text>
            <Text style={[styles.sub, { color: t.colors.textSub }]} numberOfLines={1} ellipsizeMode="tail">
              {item.upper.name}
            </Text>
          </View>
        </RNTouchableOpacity>
        {/* 操作按钮 - 绝对定位在右侧 */}
        <View style={styles.actions}>
          {item.parts && item.parts.length > 1 && (
            <RNTouchableOpacity onPress={onExpandToggle} style={styles.expandButton} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Icon name={isExpanded ? 'chevron-up' : 'chevron-down'} size={20} color={t.colors.textHint} />
            </RNTouchableOpacity>
          )}
          <IconButton name="delete" size={20} color={t.colors.error} onPress={() => removeFromQueue(item.bvid)} />
        </View>
      </View>
      {isExpanded && item.parts && item.parts.length > 1 && (
        <View style={[styles.partsContainer, { borderLeftColor: t.colors.divider }]}> 
          {item.parts.map((part) => (
            <RNTouchableOpacity
              key={part.cid}
              style={styles.partItem}
              onPress={() => onPartPress(part.cid, part.title)}
              activeOpacity={0.7}
            >
              <Text style={[styles.partTitle, { color: t.colors.textSub }]} numberOfLines={1}>
                {part.title}
              </Text>
              <Text style={[styles.partDuration, { color: t.colors.textHint }]}>{formatDuration(part.duration)}</Text>
            </RNTouchableOpacity>
          ))}
        </View>
      )}
    </View>
  ));

  const handlePartPress = useCallback(async (bvid: string, cid: number, partTitle: string) => {
    try {
      await playSpecificPart(bvid, cid, partTitle);
      onClose();
    } catch {}
  }, [onClose]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<FavoriteVideo>) => (
      <PlaylistItem
        item={item}
        onPlay={() => handlePress(item.bvid)}
        isExpanded={expandedBvid === item.bvid}
        onPartPress={(cid, partTitle) => handlePartPress(item.bvid, cid, partTitle)}
        onExpandToggle={() => setExpandedBvid((prev) => (prev === item.bvid ? null : item.bvid))}
        isCurrent={item.bvid === currentBvid}
        primaryColor={t.colors.primary}
      />
    ),
    [t.colors, expandedBvid, handlePress, handlePartPress, currentBvid]
  );

  const handleScrollToIndexFailed = useCallback((info: any) => {
    const timer = setTimeout(() => {
      listRef.current?.scrollToIndex({
        index: info.index,
        animated: true,
        viewPosition: 0.5,
      });
    }, 500);
  }, []);

  const handleLoadMore = useCallback(async () => {
    if (loadingMore) return;
    if (!playContext || !playContext.folderId) return;
    if (usePlayerStore.getState().playMode !== 'sequential') return;

    const folderStore = useFolderDataStore.getState();
    // 仅当当前播放的文件夹与全局 Store 的文件夹一致时才加载更多
    if (folderStore.folderId !== playContext.folderId) return;
    if (!folderStore.hasMore) return;

    setLoadingMore(true);
    try {
      const beforeList = folderStore.getDisplayedList();
      await folderStore.loadMore();
      const afterList = folderStore.getDisplayedList();

      const newItems = afterList.slice(beforeList.length);
      if (newItems.length > 0) {
        await appendQueue(newItems);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, playContext, appendQueue]);

  const isGlass = !!t.glass;

  const playlistContent = (
    <>
      <View style={[styles.header, { borderBottomColor: t.colors.divider }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[styles.headerTitle, { color: t.colors.text, marginRight: 8 }]}>播放列表</Text>
          <IconButton
            name={playMode === 'shuffle' ? 'shuffle' : 'repeat'}
            size={20}
            color={t.colors.text}
            onPress={togglePlayMode}
            disabled={syncStatus === 'syncing'}
          />
        </View>
        <IconButton name="close" size={24} color={t.colors.text} onPress={onClose} />
      </View>
      {visible && (
        <FlatList
          key={`list-${visible}`}
          ref={listRef}
          data={queue}
          keyExtractor={(item) => item.bvid}
          renderItem={renderItem}
          onScrollToIndexFailed={handleScrollToIndexFailed}
          contentContainerStyle={styles.list}
          initialScrollIndex={initialIndex}
          getItemLayout={(data, index) => ({ length: 64, offset: 64 * index, index })}
          initialNumToRender={10}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
          showsVerticalScrollIndicator={false}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.5}
        />
      )}
    </>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        {isGlass ? (
          <GlassView style={{ maxHeight: '80%', borderTopLeftRadius: 12, borderTopRightRadius: 12, paddingBottom: 20 }} borderRadius={12}>
            {playlistContent}
          </GlassView>
        ) : (
          <View style={[styles.container, { backgroundColor: t.colors.background }]}>{playlistContent}</View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  container: {
    maxHeight: '80%',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingBottom: 20,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
  },
  list: {
    paddingHorizontal: 12,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginVertical: 4,
    borderRadius: 8,
    position: 'relative',
  },
  infoTouchable: {
    flex: 1,
    paddingRight: 80,
    justifyContent: 'center',
  },
  info: {
    width: '115%',
  },
  title: {
    fontSize: 14,
    fontWeight: '500',
  },
  sub: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  actions: {
    position: 'absolute',
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 10,
  },
  expandButton: {
    padding: 4,
    marginRight: 4,
  },
  partsContainer: {
    marginLeft: 20,
    borderLeftWidth: 1,
    borderLeftColor: '#ddd',
    paddingLeft: 8,
    marginBottom: 4,
  },
  partItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    paddingRight: 8,
  },
  partTitle: {
    flex: 1,
    fontSize: 13,
    color: '#555',
  },
  partDuration: {
    fontSize: 11,
    color: '#999',
  },
});