import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Alert,
  ToastAndroid,
  Text,
  TextInput,
  SafeAreaView,
  StatusBar,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Header } from '../components/Header';
import { useSelectionStore } from '../store/selectionStore';
import TrackPlayer from 'react-native-track-player';
import { usePlayerStore } from '../store/playerStore';
import { ListItem } from '../components/ListItem';
import { IconButton } from '../components/IconButton';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService } from '../services';
import { appendQueue as tpAppendQueue, loadQueue } from '../services/trackPlayer';
import { useAuthStore } from '../store/authStore';
import { useSettingsStore } from '../store/settingsStore';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavoriteFolder } from '../types/domain';

export const FoldersScreen = ({ navigation }: any) => {
  const t = useTheme();
  const uid = useAuthStore((s) => s.userId);
  const hiddenFolderIds = useSettingsStore((s) => s.hiddenFolderIds);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const { selectedIds, toggle, clear } = useSelectionStore();
  const [allFolders, setAllFolders] = useState<FavoriteFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const insets = useSafeAreaInsets();

  // 根据用户偏好过滤出可见的收藏夹
  const folders = allFolders
    ? allFolders.filter((f) => !hiddenFolderIds.includes(f.id))
    : null;

  // 全局搜索关键字
  const [searchQuery, setSearchQuery] = useState('');
  const filteredFolders = folders
    ? folders.filter((f) =>
        f.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : null;

  // 统计可见视频总数（基于过滤后结果）
  const totalCount = (filteredFolders ?? []).reduce(
    (acc, f) => acc + f.mediaCount,
    0
  );

  const load = useCallback(
    async (force = false) => {
      if (!uid) return;
      setError(null);
      try {
        const data = await favoriteService.getFolders(uid, force);
        setAllFolders(data);
      } catch (e: any) {
        setError(e.message || '加载失败');
      } finally {
        setRefreshing(false);
      }
    },
    [uid]
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    StatusBar.setBarStyle(t.isDark ? 'light-content' : 'dark-content');
    StatusBar.setTranslucent(true);
  }, [t.isDark]);

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.lg, gap: t.spacing.md },
  });

  const handleRandomPlayAll = async () => {
    const globalIndex = favoriteService.getGlobalIndex();
    if (globalIndex.length === 0) {
      if (Platform.OS === 'android') {
        ToastAndroid.show(
          '全局索引为空或正在同步中，请稍后再试',
          ToastAndroid.SHORT
        );
      } else {
        Alert.alert('提示', '全局索引为空或正在同步中，请稍后再试');
      }
      return;
    }
    const shuffled = [...globalIndex].sort(() => Math.random() - 0.5);
    setQueue(shuffled, shuffled[0]?.bvid);
    await loadQueue(shuffled, shuffled[0]?.bvid);
    await TrackPlayer.play();
    navigation.navigate('Player');
  };

  return (
    <SafeAreaView style={[s.container, { paddingTop: insets.top }]}>
      <StatusBar
        barStyle={t.isDark ? 'light-content' : 'dark-content'}
        translucent
        backgroundColor="transparent"
      />
      {/* 搜索栏 */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: t.spacing.lg,
          paddingVertical: t.spacing.md,
        }}
      >
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: t.colors.surfaceHigh,
            borderRadius: 20,
            paddingHorizontal: t.spacing.md,
            height: 40,
          }}
        >
          <Icon name="magnify" size={20} color={t.colors.textHint} />
          <TextInput
            style={{
              flex: 1,
              marginLeft: t.spacing.sm,
              color: t.colors.text,
              fontSize: t.fontSize.base,
              padding: 0,
            }}
            placeholder="搜索收藏夹"
            placeholderTextColor={t.colors.textHint}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>
        <IconButton
          name="cog-outline"
          size={24}
          color={t.colors.text}
          style={{ marginLeft: t.spacing.md }}
          onPress={() => navigation.navigate('Settings')}
        />
      </View>

      {filteredFolders === null && !error ? (
        <Loading />
      ) : error ? (
        <ErrorView message={error} onRetry={() => load(true)} />
      ) : filteredFolders!.length === 0 ? (
        <Empty
          title={searchQuery ? '没有匹配的收藏夹' : '没有可见的收藏夹'}
          hint={searchQuery ? '' : '可在设置 > 可见收藏夹偏好中调整展示的收藏夹'}
        />
      ) : (
        <FlatList
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          data={filteredFolders}
          ListHeaderComponent={
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: t.spacing.md,
              }}
            >
              {/* 随机播放全部 */}
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center' }}
                onPress={handleRandomPlayAll}
              >
                <Icon name="play-circle" size={28} color={t.colors.text} />
                <Text
                  style={{
                    marginLeft: t.spacing.sm,
                    fontSize: t.fontSize.lg,
                    color: t.colors.text,
                    fontWeight: '500',
                  }}
                >
                  随机播放全部 ({totalCount})
                </Text>
              </TouchableOpacity>

              {/* 右侧按钮组 */}
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <IconButton
                  name="sort-variant"
                  size={24}
                  color={t.colors.text}
                  onPress={() => {
                    if (Platform.OS === 'android') {
                      ToastAndroid.show('排序功能开发中', ToastAndroid.SHORT);
                    } else {
                      Alert.alert('提示', '排序功能开发中');
                    }
                  }}
                />
                <IconButton
                  name="cog-outline"
                  size={24}
                  color={t.colors.text}
                  style={{ marginLeft: t.spacing.sm }}
                  onPress={() => navigation.navigate('Settings')}
                />
                <IconButton
                  name={isMultiSelectMode ? 'checkbox-marked' : 'checkbox-blank-outline'}
                  size={24}
                  color={t.colors.text}
                  style={{ marginLeft: t.spacing.sm }}
                  onPress={() => {
                    if (isMultiSelectMode) {
                      setIsMultiSelectMode(false);
                      clear();
                    } else {
                      setIsMultiSelectMode(true);
                    }
                  }}
                />
              </View>
            </View>
          }
          keyExtractor={(it) => String(it.id)}
          ItemSeparatorComponent={() => (
            <View style={{ height: t.spacing.md }} />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => {
                if (isMultiSelectMode) {
                  toggle(item.id);
                } else {
                  navigation.navigate('Videos', {
                    mediaId: item.id,
                    title: item.title,
                  });
                }
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: t.spacing.md,
                paddingHorizontal: t.spacing.lg,
                backgroundColor: t.colors.surface,
              }}
            >
              {isMultiSelectMode && (
                <IconButton
                  name={selectedIds.has(item.id) ? 'checkbox-marked' : 'checkbox-blank-outline'}
                  size={24}
                  color={t.colors.text}
                />
              )}
              <View style={{ flex: 1, marginLeft: t.spacing.md }}>
                <ListItem
                  title={item.title}
                  subtitle={`${item.mediaCount} 个视频`}
                  icon="folder-music-outline"
                  showArrow={!isMultiSelectMode}
                  onPress={
                    isMultiSelectMode
                      ? undefined
                      : () => {
                          navigation.navigate('Videos', {
                            mediaId: item.id,
                            title: item.title,
                          });
                        }
                  }
                />
              </View>
            </TouchableOpacity>
          )}
        />
      )}
      {/* Mix Play Bar */}
      {selectedIds.size > 0 && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: t.spacing.md,
            backgroundColor: t.colors.surface,
            borderTopWidth: 1,
            borderColor: t.colors.divider,
          }}
        >
          <Button
            title="混合播放"
            onPress={async () => {
              try {
                // Fetch all videos from selected folders
                const ids = Array.from(selectedIds);
                let allVideos: any[] = [];
                const globalIndex = favoriteService.getGlobalIndex();

                if (globalIndex.length > 0) {
                  allVideos = globalIndex.filter((v) =>
                    v.folderIds?.some((id) => ids.includes(id))
                  );
                } else {
                  const fetchAll = async (folderId: number) => {
                    const videos: any[] = [];
                    let page = 1;
                    let hasMore = true;
                    while (hasMore) {
                      const res = await favoriteService.getVideos(
                        folderId,
                        page
                      );
                      videos.push(...res.list);
                      hasMore = res.hasMore;
                      page += 1;
                    }
                    return videos;
                  };
                  const results = await Promise.all(
                    ids.map(fetchAll)
                  );
                  allVideos = results.flat();
                }

                // Shuffle
                const shuffled = allVideos
                  .slice()
                  .sort(() => Math.random() - 0.5);

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
            }}
          />
          <IconButton
            name="close"
            size={24}
            color={t.colors.text}
            onPress={clear}
          />
        </View>
      )}
      <MiniPlayer />
    </SafeAreaView>
  );
};
