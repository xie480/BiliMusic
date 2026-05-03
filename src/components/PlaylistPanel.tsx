import React, { useCallback, memo } from 'react';
import { View, Text, StyleSheet, Modal } from 'react-native';
import { TouchableOpacity } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams } from 'react-native-draggable-flatlist';
import { useTheme } from '../theme';
import { usePlayerStore } from '../store/playerStore';
import { IconButton } from './IconButton';
import type { FavoriteVideo } from '../types/domain';

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
  const ITEM_HEIGHT = 70; // approximate fixed height for list item

  const PlaylistItem = memo(({ item, drag, isActive, getIndex }: RenderItemParams<FavoriteVideo>) => (
    <TouchableOpacity
      style={[styles.item, { backgroundColor: isActive ? t.colors.surfaceHigh : t.colors.surface }]}
      onLongPress={drag}
      activeOpacity={0.8}
    >
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={1}>{item.title}</Text>
        <Text style={styles.sub} numberOfLines={1}>{item.upper.name}</Text>
      </View>
      <View style={styles.actions}>
        {/* 删除按钮 */}
        <IconButton
          name="delete"
          size={20}
          color={t.colors.error}
          onPress={() => removeFromQueue(item.bvid)}
        />
      </View>
    </TouchableOpacity>
  ));

  const renderItem = useCallback(
    ({ item, drag, isActive, getIndex }: RenderItemParams<FavoriteVideo>) => (
      <PlaylistItem item={item} drag={drag} isActive={isActive} getIndex={getIndex} />
    ),
    [t.colors, removeFromQueue]
  );

  const handleDragEnd = useCallback(
    ({ data }: { data: FavoriteVideo[] }) => {
      // 将新的顺序同步到 store 中
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
            getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
            initialNumToRender={5}
            maxToRenderPerBatch={10}
            windowSize={5}
            removeClippedSubviews={true}
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
});