import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { Header } from '../components/Header';
import { ListItem } from '../components/ListItem';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { IconButton } from '../components/IconButton';
import { favoriteService } from '../services';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../theme';
import type { FavoriteFolder } from '../types/domain';

export const FoldersScreen = ({ navigation }: any) => {
  const t = useTheme();
  const uid = useUserStore((s) => s.uid);
  const [folders, setFolders] = useState<FavoriteFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
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

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.lg, gap: t.spacing.md },
  });

  return (
    <View style={s.container}>
      <Header
        title="收藏夹"
        showBack
        right={<IconButton name="cog-outline" onPress={() => navigation.navigate('Settings')} />}
      />
      {folders === null && !error ? (
        <Loading />
      ) : error ? (
        <ErrorView message={error} onRetry={() => load(true)} />
      ) : folders!.length === 0 ? (
        <Empty
          title="没有公开的收藏夹"
          hint="可在设置中填入 SESSDATA 以加载私密收藏夹"
        />
      ) : (
        <FlatList
          contentContainerStyle={s.list}
          data={folders}
          keyExtractor={(it) => String(it.id)}
          ItemSeparatorComponent={() => <View style={{ height: t.spacing.md }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.primary} />
          }
          renderItem={({ item }) => (
            <View style={{ borderRadius: t.radius.lg, overflow: 'hidden' }}>
              <ListItem
                title={item.title}
                subtitle={`${item.mediaCount} 个视频`}
                icon="folder-music-outline"
                showArrow
                onPress={() =>
                  navigation.navigate('Videos', {
                    mediaId: item.id, title: item.title,
                  })
                }
              />
            </View>
          )}
        />
      )}
      <MiniPlayer />
    </View>
  );
};
