import React, { useCallback, memo, useState } from 'react';
import { View, Text, StyleSheet, Modal } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { useTheme } from '../theme';
import { usePlayerStore } from '../store/playerStore';
import { IconButton } from './IconButton';
import type { FavoriteVideo } from '../types/domain';
import { formatDuration } from '../utils/format';
import { playSpecificPart } from '../services/trackPlayer';

/**
 * 全局播放列表面板，支持拖拽排序和侧滑删除。
 * 通过 Zustand playerStore 与原生 TrackPlayer 同步。
 */
export const PlaylistPanel = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const t = useTheme();
  const queue = usePlayerStore((s) => s.queue);
  const reorderQueue = usePlayerStore((s) => s.reorderQueue);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const playMode = usePlayerStore((s) => s.playMode);
  const togglePlayMode = usePlayerStore((s) => s.togglePlayMode);
  const [expandedBvid, setExpandedBvid] = useState<string | null>(null);

  const PlaylistItem = memo(({ item, drag, isActive, getIndex, onPress, isExpanded, onPartPress }: RenderItemParams<FavoriteVideo> & { onPress: () => void; isExpanded: boolean; onPartPress: (cid: number, partTitle: string) => void }) => (
    <View>
      <TouchableOpacity
        style={[styles.item, { backgroundColor: isActive ? t.colors.surfaceHigh : t.colors.surface }]}
        onLongPress={drag}
        onPress={onPress}
        activeOpacity={0.8}
      >
        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
          <Text style={styles.sub} numberOfLines={1}>{item.upper.name}</Text>
        </View>
        <View style={styles.actions}>
          <IconButton
            name="delete"
            size={20}
            color={t.colors.error}
            onPress={() => removeFromQueue(item.bvid)}
          />
        </View>
      </TouchableOpacity>
      {isExpanded && item.parts && item.parts.length > 1 && (
        <View style={styles.partsContainer}>
          {item.parts.map((part) => (
            <TouchableOpacity
              key={part.cid}
              style={styles.partItem}
              onPress={() => onPartPress(part.cid, part.title)}
              activeOpacity={0.7}
            >
              <Text style={styles.partTitle} numberOfLines={1}>{part.title}</Text>
              <Text style={styles.partDuration}>{formatDuration(part.duration)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  ));

  const handlePress = useCallback((bvid: string) => {
    setExpandedBvid((prev) => (prev === bvid ? null : bvid));
  }, []);

  const handlePartPress = useCallback(async (bvid: string, cid: number, partTitle: string) => {
    try {
      await playSpecificPart(bvid, cid, partTitle);
      onClose();
    } catch {}
  }, [onClose]);

  const renderItem = useCallback(
    ({ item, drag, isActive, getIndex }: RenderItemParams<FavoriteVideo>) => (
      <PlaylistItem
        item={item}
        drag={drag}
        isActive={isActive}
        getIndex={getIndex}
        onPress={() => handlePress(item.bvid)}
        isExpanded={expandedBvid === item.bvid}
        onPartPress={(cid, partTitle) => handlePartPress(item.bvid, cid, partTitle)}
      />
    ),
    [t.colors, removeFromQueue, expandedBvid, handlePress, handlePartPress]
  );

  const handleDragEnd = useCallback(
    ({ data }: { data: FavoriteVideo[] }) => {
      reorderQueue(data);
    },
    [reorderQueue]
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.container, { backgroundColor: t.colors.background }]}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>播放列表</Text>
            <IconButton name="close" size={24} color={t.colors.text} onPress={onClose} />
          </View>
          <DraggableFlatList
            data={queue}
            keyExtractor={(item) => item.bvid}
            renderItem={renderItem}
            onDragEnd={handleDragEnd}
            contentContainerStyle={styles.list}
            initialNumToRender={5}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews={true}
            showsVerticalScrollIndicator={false}
          />
        </View>
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
  },
  info: {
    flex: 1,
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
    marginLeft: 8,
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
    marginLeft: 8,
  },
});