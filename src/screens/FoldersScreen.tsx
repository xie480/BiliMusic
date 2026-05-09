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
  StatusBar,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Header } from '../components/Header';
import { useSelectionStore } from '../store/selectionStore';
import TrackPlayer from 'react-native-track-player';
import { usePlayerStore } from '../store/playerStore';
import { useProgressStore } from '../store/progressStore';
import { ListItem } from '../components/ListItem';
import { IconButton } from '../components/IconButton';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService, loadGlobalIndexCache } from '../services/favoriteService';
import { appendQueue as tpAppendQueue, loadQueue, playWithIntent, resolveCurrentTrack } from '../services/trackPlayer';
import { useAuthStore } from '../store/authStore';
import { prefetchAudioUrl } from '../services/dataPrefetcher';
import { useSettingsStore } from '../store/settingsStore';
import { useSyncStore } from '../store/syncStore';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavoriteFolder, FavoriteVideo } from '../types/domain';
import FastImage from 'react-native-fast-image';
import { formatDuration } from '../utils/format';

export const FoldersScreen = ({ navigation }: any) => {
  const t = useTheme();
  const isGlass = !!t.glass;
  const uid = useAuthStore((s) => s.userId);
  const hiddenFolderIds = useSettingsStore((s) => s.hiddenFolderIds);
  const setQueue = usePlayerStore((s) => s.setQueue);
  const selectedIds = useSelectionStore((s) => s.selectedIds);
  const toggle = useSelectionStore((s) => s.toggle);
  const clear = useSelectionStore((s) => s.clear);
  const [allFolders, setAllFolders] = useState<FavoriteFolder[] | null>(null);
  const [globalIndexReady, setGlobalIndexReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const insets = useSafeAreaInsets();
  const syncStatus = useSyncStore((s) => s.syncStatus);
  const isSyncing = syncStatus === 'syncing';

  // 根据用户偏好过滤出可见的收藏夹
  const folders = allFolders
    ? allFolders.filter((f) => !hiddenFolderIds.includes(f.id))
    : null;

  // 全局搜索关键字
  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'title' | 'author'>('title');
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
  // Determine if we are performing a global search based on non-empty query
  const isGlobalSearch = searchQuery.trim().length > 0;
  const globalIndex = favoriteService.getGlobalIndex();
  const isGlobalIndexEmpty = globalIndex.length === 0;
  const isSearchDisabled = isSyncing || isGlobalIndexEmpty;
  const filteredVideos = isGlobalSearch ? globalIndex.filter((v) => {
    if (searchMode === 'title') {
      return v.title.toLowerCase().includes(searchQuery.toLowerCase());
    } else {
      return v.upper?.name?.toLowerCase().includes(searchQuery.toLowerCase());
    }
  }) : [];

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

  // 【修复】组件挂载时确保全局索引缓存已加载，并触发重新渲染以更新 isGlobalIndexEmpty
  useEffect(() => {
    loadGlobalIndexCache().then(() => setGlobalIndexReady(true));
  }, []);

  useEffect(() => {
    StatusBar.setBarStyle(t.isDark ? 'light-content' : 'dark-content');
    StatusBar.setTranslucent(true);
  }, [t.isDark]);

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const statusBarHeight = Platform.OS === 'android' ? Math.max(insets.top, StatusBar.currentHeight ?? 0) : insets.top;

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    list: { padding: t.spacing.lg, gap: t.spacing.md },
  });

  const handleRandomPlayAll = async () => {
    const shuffled = await favoriteService.getRandomVideos(undefined, 100);
    if (shuffled.length === 0) {
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
    setQueue(shuffled, shuffled[0]?.bvid);
    // ======== 【P0防闪烁优化】跳转前清空旧播放上下文 ========
    usePlayerStore.getState().setResolving(true);
    useProgressStore.getState().resetProgress();
    // 【P0性能优化】极速并发预取：与 loadQueue Bridge 调用并行执行
    const target = shuffled[0];
    if (target) {
      prefetchAudioUrl(target.bvid, target.parts?.[0]?.cid).catch(() => {});
    }
    const version = await loadQueue(shuffled, shuffled[0]?.bvid);
    // 【修复E】显式调用 play()，不再依赖 _pendingPlay 事件标志
    await playWithIntent();
    // 【P0性能优化】主动触发解析，跳过 PlaybackError 等待
    resolveCurrentTrack(version).catch(() => {});
    navigation.navigate('Player');
  };

  return (
    // 【性能优化】collapsable=false 确保 Android 上屏幕容器不被 View 融合优化
    <View style={s.container} {...(Platform.OS === 'android' ? { collapsable: false as any } : {})}>
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
          paddingTop: t.spacing.md + statusBarHeight,
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
            opacity: isSearchDisabled ? 0.4 : 1,
          }}
        >
          <Icon name="magnify" size={20} color={t.colors.textHint} />
          <TextInput
            style={{
              flex: 1,
              marginLeft: t.spacing.sm,
              color: isSearchDisabled ? t.colors.textHint : t.colors.text,
              fontSize: t.fontSize.base,
              padding: 0,
            }}
            placeholder={isSyncing ? "索引同步中，暂不可搜索" : isGlobalIndexEmpty ? "全局索引为空，暂不可搜索" : (searchMode === 'title' ? "请输入歌曲名" : "请输入作者")}
            placeholderTextColor={t.colors.textHint}
            value={searchQuery}
            onChangeText={setSearchQuery}
            editable={!isSearchDisabled}
          />
          <IconButton
            name={searchMode === 'title' ? 'music-note' : 'account'}
            size={24}
            color={t.colors.text}
            style={{ marginLeft: t.spacing.sm }}
            disabled={isSearchDisabled}
            onPress={() => setSearchMode(searchMode === 'title' ? 'author' : 'title')}
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
      ) : !isGlobalSearch && filteredFolders!.length === 0 ? (
        <Empty
          title="没有可见的收藏夹"
          hint="可在设置 > 可见收藏夹偏好中调整展示的收藏夹"
        />
      ) : isGlobalSearch && filteredVideos.length === 0 ? (
        <Empty
          title="没有匹配的歌曲"
          hint="尝试更换搜索词或搜索模式"
        />
      ) : isGlobalSearch ? (
        <FlatList
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          data={filteredVideos}
          keyExtractor={(it) => it.bvid}
          // ========== 性能优化参数 ==========
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={5}
          initialNumToRender={10}
          getItemLayout={(_data, index) => ({
            length: 96,
            offset: 96 * index,
            index,
          })}
          // =================================
          ItemSeparatorComponent={() => <View style={{ height: t.spacing.md }} />}
          renderItem={({ item, index }) => (
            <TouchableOpacity
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                paddingVertical: t.spacing.sm,
                paddingHorizontal: t.spacing.lg,
                backgroundColor: t.colors.surface,
              }}
              onPress={async () => {
                const video = filteredVideos[index];
                if (!video) return;
                try {
                  const MAX_QUEUE = 100;
                  const queueVideos = filteredVideos.length > MAX_QUEUE
                    ? filteredVideos.slice(0, MAX_QUEUE)
                    : filteredVideos;
                  setQueue(queueVideos, video.bvid);
                  // 【P0防闪烁优化】跳转前清空旧播放上下文
                  usePlayerStore.getState().setResolving(true);
                  useProgressStore.getState().resetProgress();
                  prefetchAudioUrl(video.bvid, video.parts?.[0]?.cid).catch(() => {});
                  const version = await loadQueue(queueVideos, video.bvid);
                  await playWithIntent();
                  resolveCurrentTrack(version).catch(() => {});
                  navigation.navigate('Player');
                } catch (e: any) {
                  const msg = e.message || '播放失败';
                  if (Platform.OS === 'android') {
                    ToastAndroid.show(msg, ToastAndroid.SHORT);
                  } else {
                    Alert.alert('播放错误', msg);
                  }
                  usePlayerStore.getState().setResolving(false);
                }
              }}
            >
              <View>
                <FastImage
                  source={{ uri: item.cover }}
                  style={{
                    width: 120,
                    height: 75,
                    borderRadius: 8,
                    backgroundColor: t.colors.surfaceHigh,
                  }}
                  resizeMode={FastImage.resizeMode.cover}
                />
                <View
                  style={{
                    position: 'absolute',
                    bottom: 4,
                    right: 4,
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    paddingHorizontal: 4,
                    paddingVertical: 2,
                    borderRadius: 4,
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 10 }}>
                    {formatDuration(item.duration)}
                  </Text>
                </View>
              </View>
              <View style={{ flex: 1, marginLeft: t.spacing.md, justifyContent: 'center' }}>
                <Text
                  style={{
                    fontSize: t.fontSize.base,
                    color: t.colors.text,
                    fontWeight: '500',
                    marginBottom: t.spacing.xs,
                  }}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Icon name="account-outline" size={14} color={t.colors.textHint} />
                  <Text
                    style={{
                      fontSize: t.fontSize.sm,
                      color: t.colors.textHint,
                      marginLeft: 2,
                      flex: 1,
                    }}
                    numberOfLines={1}
                  >
                    {item.upper?.name || '未知作者'}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          contentContainerStyle={s.list}
          showsVerticalScrollIndicator={false}
          data={filteredFolders}
          // ========== 性能优化参数 ==========
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={5}
          initialNumToRender={10}
          getItemLayout={(_data, index) => ({
            length: 72,
            offset: 72 * index,
            index,
          })}
          // =================================
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
                {/* 设置按钮已在右上角保留，此处已移除 */}
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
              activeOpacity={0.7}
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
                borderRadius: t.radius.lg,
                borderWidth: isGlass ? 0.5 : 0,
                borderColor: isGlass ? (t.isDark ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.6)') : 'transparent',
                ...Platform.select({
                  ios: {
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: isGlass ? 1 : 2 },
                    shadowOpacity: isGlass ? 0.04 : 0.08,
                    shadowRadius: isGlass ? 4 : 8,
                  },
                  android: { elevation: isGlass ? 0 : 3 },
                }),
              }}
            >
              {isMultiSelectMode && (
                <View style={{ padding: 6 }}>
                  <Icon
                    name={selectedIds.has(item.id) ? 'checkbox-marked' : 'checkbox-blank-outline'}
                    size={24}
                    color={t.colors.text}
                  />
                </View>
              )}
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: t.radius.md,
                  backgroundColor: t.colors.primaryLight,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: t.spacing.md,
                }}
              >
                <Icon name="folder-music-outline" size={22} color={t.colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={{ fontSize: t.fontSize.md, color: t.colors.text, fontWeight: '500' }}
                  numberOfLines={1}
                >
                  {item.title}
                </Text>
                <Text
                  style={{ fontSize: t.fontSize.sm, color: t.colors.textSub, marginTop: 2 }}
                  numberOfLines={1}
                >
                  {item.mediaCount} 个视频
                </Text>
              </View>
              {!isMultiSelectMode && (
                <Icon name="chevron-right" size={22} color={t.colors.textHint} />
              )}
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
                const ids = Array.from(selectedIds);
                // 从选中的收藏夹中随机获取视频
                const results = await Promise.all(
                  ids.map(id => favoriteService.getRandomVideos(id.toString(), 50))
                );
                let allVideos = results.flat();
                
                // 再次打乱混合后的结果
                const shuffled = allVideos.sort(() => Math.random() - 0.5);

                if (shuffled.length === 0) {
                   throw new Error('选中的收藏夹为空');
                }

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
    </View>
  );
};
