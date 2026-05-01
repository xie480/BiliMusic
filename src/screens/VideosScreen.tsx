import React, { useEffect, useState, useCallback } from 'react';
import {
  View, FlatList, TouchableOpacity, Text, StyleSheet,
  ActivityIndicator,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import TrackPlayer from 'react-native-track-player';
import { Header } from '../components/Header';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService } from '../services';
import { loadQueue } from '../services/trackPlayer';
import { usePlayerStore } from '../store/playerStore';
import { formatDuration } from '../utils/format';
import { useTheme } from '../theme';
import type { FavoriteVideo } from '../types/domain';

export const VideosScreen = ({ route, navigation }: any) => {
  const t = useTheme();
  const { mediaId, title } = route.params;
  const setQueue = usePlayerStore((s) => s.setQueue);

  const [list, setList] = useState<FavoriteVideo[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initing, setIniting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const r = await favoriteService.getVideos(mediaId, page);
      setList((v) => [...v, ...r.list]);
      setHasMore(r.hasMore);
      setPage((p) => p + 1);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setIniting(false);
    }
  }, [mediaId, page, hasMore, loading]);

  useEffect(() => { loadMore(); /* eslint-disable-next-line */ }, []);

  const playFrom = async (idx: number) => {
    const target = list[idx];
    setQueue(list, target.bvid);
    await loadQueue(list, target.bvid);
    await TrackPlayer.play();
    navigation.navigate('Player');
  };

  const playAll = () => playFrom(0);
  const shuffle = () => {
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    setList(shuffled);
    playFrom(0);
  };

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    actions: {
      flexDirection: 'row', padding: t.spacing.lg, gap: t.spacing.md,
    },
    actionBtn: { flex: 1 },
    item: {
      flexDirection: 'row',
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.md,
    },
    cover: {
      width: 112, height: 70, borderRadius: t.radius.sm,
      backgroundColor: t.colors.surfaceHigh,
    },
    info: { flex: 1, marginLeft: t.spacing.md, justifyContent: 'space-between' },
    title: { fontSize: t.fontSize.base, color: t.colors.text },
    meta: { flexDirection: 'row', justifyContent: 'space-between' },
    upper: { fontSize: t.fontSize.xs, color: t.colors.textSub },
    duration: { fontSize: t.fontSize.xs, color: t.colors.textHint },
    footer: { padding: t.spacing.lg, alignItems: 'center' },
  });

  return (
    <View style={s.container}>
      <Header title={`${title} (${list.length})`} showBack />
      {initing ? (
        <Loading />
      ) : error && list.length === 0 ? (
        <ErrorView message={error} onRetry={loadMore} />
      ) : list.length === 0 ? (
        <Empty title="收藏夹是空的" />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(it) => it.bvid}
          ListHeaderComponent={
            <View style={s.actions}>
              <Button title="▶ 全部播放" onPress={playAll} style={s.actionBtn} />
              <Button title="🔀 随机播放" variant="secondary" onPress={shuffle} style={s.actionBtn} />
            </View>
          }
          renderItem={({ item, index }) => (
            <TouchableOpacity activeOpacity={0.7} style={s.item} onPress={() => playFrom(index)}>
              <FastImage source={{ uri: item.cover }} style={s.cover} />
              <View style={s.info}>
                <Text style={s.title} numberOfLines={2}>{item.title}</Text>
                <View style={s.meta}>
                  <Text style={s.upper} numberOfLines={1}>{item.upper.name}</Text>
                  <Text style={s.duration}>{formatDuration(item.duration)}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            hasMore && loading ? (
              <View style={s.footer}>
                <ActivityIndicator color={t.colors.primary} />
              </View>
            ) : !hasMore ? (
              <View style={s.footer}>
                <Text style={{ color: t.colors.textHint, fontSize: t.fontSize.xs }}>到底了</Text>
              </View>
            ) : null
          }
        />
      )}
      <MiniPlayer />
    </View>
  );
};
