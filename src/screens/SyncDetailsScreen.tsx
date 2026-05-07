import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Header } from '../components/Header';
import { useTheme } from '../theme';
import { favoriteService } from '../services/favoriteService';
import { getAllPlaylistMeta } from '../db/operations';
import { useAuthStore } from '../store/authStore';
import type { FavoriteFolder } from '../types/domain';
import type { PlaylistMeta } from '../db/models/PlaylistMeta';
import { IconButton } from '../components/IconButton';
import { Button } from '../components/Button';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';

interface FolderSyncInfo {
  folder: FavoriteFolder;
  meta: PlaylistMeta | null;
}

/** 根据 PlaylistMeta 的状态生成显示文字和颜色 */
function getSyncStatusDisplay(meta: PlaylistMeta | null) {
  if (!meta) {
    return { text: '未同步', color: 'textSub' as const };
  }
  switch (meta.syncStatus) {
    case 'syncing':
      return { text: `同步中 (${meta.localSyncedCount}/${meta.remoteVideoCount})`, color: 'primary' as const };
    case 'success':
      if (meta.needResync) {
        return { text: `需重新同步 (${meta.localSyncedCount}/${meta.remoteVideoCount})`, color: 'warning' as const };
      }
      return { text: `已同步 (${meta.localSyncedCount}/${meta.remoteVideoCount})`, color: 'primary' as const };
    case 'failed':
      return { text: '同步失败', color: 'error' as const };
    case 'running':
      return { text: '中断（上次同步未完成）', color: 'warning' as const };
    default:
      return { text: `待同步 (${meta.localSyncedCount}/${meta.remoteVideoCount})`, color: 'textSub' as const };
  }
}

export const SyncDetailsScreen = ({ navigation }: any) => {
  const t = useTheme();
  const { userId: uid } = useAuthStore();
  const [loading, setLoading] = useState(true);
  const [foldersInfo, setFoldersInfo] = useState<FolderSyncInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  const loadData = useCallback(async () => {
    if (!uid) return;
    setLoading(true);
    try {
      const folders = await favoriteService.getFolders(uid);
      const playlistMetas = await getAllPlaylistMeta();
      const metaMap = new Map<string, PlaylistMeta>();
      for (const meta of playlistMetas) {
        metaMap.set(meta.playlistId, meta);
      }

      const info = folders.map(f => ({
        folder: f,
        meta: metaMap.get(f.id.toString()) || null,
      }));
      setFoldersInfo(info);
    } catch (e) {
      console.error('Failed to load sync details', e);
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleSelect = (id: number) => {
    const newSet = new Set(selectedIds);
    if (newSet.has(id)) {
      newSet.delete(id);
    } else {
      newSet.add(id);
    }
    setSelectedIds(newSet);
  };

  const handleDelete = async (ids: number[]) => {
    Alert.alert(
      '确认删除',
      `确定要删除选中的 ${ids.length} 个收藏夹的索引数据吗？\n这不会删除B站上的实际收藏夹。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            setLoading(true);
            try {
              for (const id of ids) {
                await favoriteService.deleteFolderIndex(id);
              }
              setSelectedIds(new Set());
              setIsMultiSelectMode(false);
              await loadData();
            } catch (e) {
              console.error('Failed to delete folder index', e);
              Alert.alert('错误', '删除失败');
              setLoading(false);
            }
          },
        },
      ]
    );
  };

  const renderItem = ({ item }: { item: FolderSyncInfo }) => {
    const { folder, meta } = item;
    const isSelected = selectedIds.has(folder.id);
    const status = getSyncStatusDisplay(meta);
    const statusColor = t.colors[status.color];

    return (
      <View style={[styles.itemContainer, { backgroundColor: t.colors.surface, borderBottomColor: t.colors.divider }]}>
        {isMultiSelectMode && (
          <IconButton
            name={isSelected ? 'checkbox-marked' : 'checkbox-blank-outline'}
            size={24}
            color={isSelected ? t.colors.primary : t.colors.textSub}
            onPress={() => toggleSelect(folder.id)}
            style={{ marginRight: t.spacing.sm }}
          />
        )}
        <View style={styles.itemContent}>
          <Text style={[styles.title, { color: t.colors.text }]} numberOfLines={1}>
            {folder.title}
          </Text>
          <Text style={[styles.subtitle, { color: statusColor }]} numberOfLines={1}>
            {status.text}
          </Text>
        </View>
        {!isMultiSelectMode && meta && (
          <IconButton
            name="delete-outline"
            size={24}
            color={t.colors.error}
            onPress={() => handleDelete([folder.id])}
          />
        )}
      </View>
    );
  };

  const styles = StyleSheet.create({
    container: { flex: 1 },
    list: { paddingBottom: t.spacing.xl },
    itemContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: t.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    itemContent: { flex: 1 },
    title: { fontSize: t.fontSize.md, fontWeight: '500', marginBottom: 4 },
    subtitle: { fontSize: t.fontSize.sm },
    footer: {
      flexDirection: 'row',
      padding: t.spacing.md,
      backgroundColor: t.colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: t.colors.divider,
      justifyContent: 'space-between',
      alignItems: 'center',
    },
  });

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <Header
        title="同步详情"
        showBack
        right={
          <IconButton
            name={isMultiSelectMode ? 'close' : 'playlist-check'}
            size={24}
            onPress={() => {
              setIsMultiSelectMode(!isMultiSelectMode);
              setSelectedIds(new Set());
            }}
          />
        }
      />
      {loading ? (
        <Loading />
      ) : foldersInfo.length === 0 ? (
        <Empty title="暂无收藏夹" />
      ) : (
        <>
          <FlatList
            data={foldersInfo}
            keyExtractor={item => item.folder.id.toString()}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
          />
          {isMultiSelectMode && (
            <View style={styles.footer}>
              <Text style={{ color: t.colors.text }}>
                已选择 {selectedIds.size} 项
              </Text>
              <Button
                title="批量删除"
                variant="primary"
                disabled={selectedIds.size === 0}
                onPress={() => handleDelete(Array.from(selectedIds))}
                style={{ backgroundColor: t.colors.error }}
              />
            </View>
          )}
        </>
      )}
    </SafeAreaView>
  );
};
