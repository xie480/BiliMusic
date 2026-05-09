import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, RefreshControl, StyleSheet, TouchableOpacity, Text, StatusBar,
} from 'react-native';
import { Header } from '../components/Header';
import { ListItem } from '../components/ListItem';
import { IconButton } from '../components/IconButton';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { favoriteService } from '../services';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavoriteFolder } from '../types/domain';

export const NoCacheFoldersScreen = ({ navigation }: any) => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const uid = useAuthStore((s) => s.userId);
  const noCacheFolderIds = useSettingsStore((s) => s.noCacheFolderIds);
  const setNoCacheFolderIds = useSettingsStore((s) => s.setNoCacheFolderIds);

  const [folders, setFolders] = useState<FavoriteFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 本地编辑中的无缓存集合（退出时保存）
  const [localNoCache, setLocalNoCache] = useState<Set<number>>(new Set(noCacheFolderIds));

  const load = useCallback(async (force = false) => {
    if (!uid) return;
    setError(null);
    try {
      const data = await favoriteService.getFolders(uid, force);
      setFolders(data);
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setRefreshing(false);
    }
  }, [uid]);

  useEffect(() => { load(); }, [load]);

  // 同步外部 noCacheFolderIds 到本地编辑状态
  useEffect(() => {
    setLocalNoCache(new Set(noCacheFolderIds));
  }, [noCacheFolderIds]);

  const toggleFolder = (id: number) => {
    setLocalNoCache(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isFolderNoCache = (id: number) => localNoCache.has(id);

  const onSave = () => {
    setNoCacheFolderIds(Array.from(localNoCache));
    navigation.goBack();
  };

  const onSelectAll = () => {
    // 全选：所有收藏夹都无缓存
    if (folders) {
      setLocalNoCache(new Set(folders.map(f => f.id)));
    }
  };

  const onDeselectAll = () => {
    // 反选：清空无缓存列表
    setLocalNoCache(new Set());
  };

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.lg, gap: t.spacing.md },
    toolbar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.md,
      backgroundColor: t.colors.surface,
      borderBottomWidth: 0.5,
      borderColor: t.colors.divider,
    },
  });

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <Header
        title="无缓存收藏夹"
        showBack
        right={folders && (
          <TouchableOpacity onPress={onSave}>
            <Text style={{ color: t.colors.primary, fontSize: t.fontSize.base, fontWeight: '600' }}>保存</Text>
          </TouchableOpacity>
        )}
      />
      {folders === null && !error ? (
        <Loading />
      ) : error ? (
        <ErrorView message={error} onRetry={() => load(true)} />
      ) : folders!.length === 0 ? (
        <Empty title="没有公开的收藏夹" hint="请在设置中填入 SESSDATA 以加载私密收藏夹" />
      ) : (
        <>
          <View style={s.toolbar}>
            <TouchableOpacity onPress={onSelectAll}>
              <Text style={{ color: t.colors.primary, fontSize: t.fontSize.sm }}>全选</Text>
            </TouchableOpacity>
            <Text style={{ color: t.colors.textSub, fontSize: t.fontSize.sm }}>
              已选 {folders!.filter(f => isFolderNoCache(f.id)).length}/{folders!.length} 个
            </Text>
            <TouchableOpacity onPress={onDeselectAll}>
              <Text style={{ color: t.colors.error, fontSize: t.fontSize.sm }}>反选</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            contentContainerStyle={s.list}
            data={folders!}
            showsVerticalScrollIndicator={false}
            keyExtractor={(it) => String(it.id)}
            extraData={localNoCache}
            ItemSeparatorComponent={() => <View style={{ height: t.spacing.md }} />}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} tintColor={t.colors.primary} />
            }
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => toggleFolder(item.id)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: t.spacing.md,
                  paddingHorizontal: t.spacing.lg,
                  backgroundColor: t.colors.surface,
                  borderRadius: t.radius.md,
                }}
              >
                <IconButton
                  name={isFolderNoCache(item.id) ? 'checkbox-marked' : 'checkbox-blank-outline'}
                  size={24}
                  color={isFolderNoCache(item.id) ? t.colors.primary : t.colors.textHint}
                />
                <View style={{ flex: 1, marginLeft: t.spacing.md }}>
                  <ListItem
                    title={item.title}
                    subtitle={`${item.mediaCount} 个视频`}
                    icon="folder-music-outline"
                    showArrow={false}
                  />
                </View>
              </TouchableOpacity>
            )}
          />
        </>
      )}
    </View>
  );
};
