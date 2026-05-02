import React, { useEffect, useState, useCallback } from 'react';
import { View, FlatList, RefreshControl, StyleSheet, TouchableOpacity, Platform, Alert, ToastAndroid, Text } from 'react-native';
import { Header } from '../components/Header';
import { useSelectionStore } from '../store/selectionStore';
import TrackPlayer from 'react-native-track-player';
// import { usePlayerStore } from '../store/playerStore'; // Unused import removed
import { ListItem } from '../components/ListItem';
import { IconButton } from '../components/IconButton';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService } from '../services';
import { appendQueue as tpAppendQueue } from '../services/trackPlayer';
import { useUserStore } from '../store/userStore';
import { useTheme } from '../theme';
import type { FavoriteFolder } from '../types/domain';

export const FoldersScreen = ({ navigation }: any) => {
  const t = useTheme();
  const uid = useUserStore((s) => s.uid);
  const { selectedIds, toggle, clear } = useSelectionStore();
  const [folders, setFolders] = useState<FavoriteFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

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
        showBack={false}
        left={<TouchableOpacity onPress={() => {
          if (isMultiSelectMode) {
            setIsMultiSelectMode(false);
            clear(); // 清空已选
          } else {
            setIsMultiSelectMode(true);
          }
        }}>
          <Text style={{ color: t.colors.text, fontSize: t.fontSize.md }}>{isMultiSelectMode ? '取消' : '多选'}</Text>
        </TouchableOpacity>}
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
            <TouchableOpacity
              onPress={() => {
                if (isMultiSelectMode) {
                  toggle(item.id);
                } else {
                  navigation.navigate('Videos', { mediaId: item.id, title: item.title });
                }
              }}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.lg, backgroundColor: t.colors.surface }}
            >
              {isMultiSelectMode && (
                <IconButton name={selectedIds.has(item.id) ? 'checkbox-marked' : 'checkbox-blank-outline'} size={24} color={t.colors.text} />
              )}
              <View style={{ flex: 1, marginLeft: t.spacing.md }}>
                <ListItem
                  title={item.title}
                  subtitle={`${item.mediaCount} 个视频`}
                  icon="folder-music-outline"
                  showArrow={!isMultiSelectMode}
                  onPress={() => {
                    if (!isMultiSelectMode) {
                      navigation.navigate('Videos', { mediaId: item.id, title: item.title });
                    }
                  }}
                />
              </View>
            </TouchableOpacity>
          )}
        />
      )}
      {/* Mix Play Bar */}
      {selectedIds.size > 0 && (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: t.spacing.md, backgroundColor: t.colors.surface, borderTopWidth: 1, borderColor: t.colors.divider }}>
          <Button title="混合播放" onPress={async () => {
            try {
              // Fetch all videos from selected folders
              const ids = Array.from(selectedIds);
              const fetchAll = async (folderId: number) => {
                const videos: any[] = [];
                let page = 1;
                let hasMore = true;
                while (hasMore) {
                  const res = await favoriteService.getVideos(folderId, page);
                  videos.push(...res.list);
                  hasMore = res.hasMore;
                  page += 1;
                }
                return videos;
              };
              const results = await Promise.all(ids.map(fetchAll));
              const allVideos = results.flat();

              // Shuffle
              const shuffled = allVideos.slice().sort(() => Math.random() - 0.5);

              // Append to queue and start playback
              await tpAppendQueue(shuffled);
              await TrackPlayer.play();
              clear();

              if (Platform.OS === 'android') {
                ToastAndroid.show('已开始混合播放', ToastAndroid.SHORT);
              } else {
                Alert.alert('提示', '已开始混合播放');
              }
            } catch (e: any) {
              const msg = e.message || '混合播放失败';
              if (Platform.OS === 'android') {
                ToastAndroid.show(msg, ToastAndroid.SHORT);
              } else {
                Alert.alert('错误', msg);
              }
            }
          }} />
          <IconButton name="close" size={24} color={t.colors.text} onPress={clear} />
        </View>
      )}
      <MiniPlayer />
    </View>
  );
};
