import React, { useEffect, useState, useCallback, useRef, memo } from 'react';
import LoggerService from '../services/LoggerService';
import {
  View,
  FlatList,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
  ToastAndroid,
  Modal,
  TextInput,
  InteractionManager,
} from 'react-native';
import FastImage from 'react-native-fast-image';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import TrackPlayer from 'react-native-track-player';
import { IconButton } from '../components/IconButton';
import { StatusBar } from 'react-native';
import { Header } from '../components/Header';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService } from '../services';
import { loadQueue, insertNext, appendQueue as tpAppendQueue } from '../services/trackPlayer';
import { usePlayerStore } from '../store/playerStore';
import { formatDuration } from '../utils/format';
import { useTheme } from '../theme';
import { useSyncStore } from '../store/syncStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavoriteVideo } from '../types/domain';
import { useFolderDataStore, SortOption } from '../store/folderDataStore';

// ========== 精细粒度的 Item 组件（React.memo 消除无关重渲染） ==========
interface VideoItemProps {
  item: FavoriteVideo;
  index: number;
  onPlay: (index: number) => void;
  onMenu: (item: FavoriteVideo) => void;
  coverColor: string;
  textColor: string;
  textHintColor: string;
  surfaceHighColor: string;
  fontSizeBase: number;
  fontSizeSm: number;
  spacingSm: number;
  spacingMd: number;
  spacingLg: number;
}

const VideoItem = memo(function VideoItem({
  item, index, onPlay, onMenu,
  coverColor, textColor, textHintColor, surfaceHighColor,
  fontSizeBase, fontSizeSm, spacingSm, spacingMd, spacingLg,
}: VideoItemProps) {
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacingSm,
        paddingHorizontal: spacingLg,
      }}
      onPress={() => onPlay(index)}
    >
      <FastImage
        source={{ uri: item.cover }}
        style={{
          width: 60,
          height: 60,
          borderRadius: 8,
          backgroundColor: surfaceHighColor,
        }}
        resizeMode={FastImage.resizeMode.cover}
      />
      <View style={{ flex: 1, marginLeft: spacingMd }}>
        <Text
          style={{
            fontSize: fontSizeBase,
            color: textColor,
            fontWeight: '500',
            marginBottom: spacingSm / 2,
          }}
          numberOfLines={2}
        >
          {item.title}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text
            style={{
              fontSize: fontSizeSm,
              color: textHintColor,
              flex: 1,
            }}
            numberOfLines={1}
          >
            {item.upper.name}
          </Text>
          <Text style={{ fontSize: fontSizeSm, color: textHintColor, marginLeft: spacingSm }}>
            {formatDuration(item.duration)}
          </Text>
        </View>
      </View>
      <IconButton
        name="dots-vertical"
        size={24}
        color={textColor}
        onPress={() => onMenu(item)}
      />
    </TouchableOpacity>
  );
});
// ========== Item 组件结束 ==========

export const VideosScreen = ({ route, navigation }: any) => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { mediaId, title } = route.params;
  const setQueue = usePlayerStore((s) => s.setQueue);
  const playMode = usePlayerStore((s) => s.playMode);
  
  const {
    list,
    hasMore,
    loading,
    error,
    searchQuery,
    sortOption,
    initFolder,
    loadMore,
    setSearchQuery,
    setSortOption,
    getDisplayedList,
    isRefreshing,
    refreshFolder,
  } = useFolderDataStore();

  const [initing, setIniting] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<FavoriteVideo | null>(null);
  const [sortModalVisible, setSortModalVisible] = useState(false);

  const syncStatus = useSyncStore((s) => s.syncStatus);
  const isSyncing = syncStatus === 'syncing';
  const globalIndex = favoriteService.getGlobalIndex();
  const isGlobalIndexEmpty = globalIndex.length === 0;
  const isSearchDisabled = isSyncing || isGlobalIndexEmpty;

  // 【性能优化】mountedRef：防止页面卸载后的异步操作更新已卸载组件的状态
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  // ========== 增量刷新按钮逻辑 ==========
  // 防抖锁：防止用户在刷新动画未结束时再次点击
  const refreshLockRef = useRef(false);

  /**
   * 处理刷新点击事件。
   * 内置防抖：若已有刷新任务在执行则静默忽略。
   * 刷新完成后通过 Toast（Android）或 Alert（iOS）反馈结果。
   */
  const handleRefresh = useCallback(async () => {
    // Step 1: 防抖检测，避免重复触发
    if (refreshLockRef.current || isRefreshing) return;
    refreshLockRef.current = true;

    try {
      const newCount = await refreshFolder(mediaId);
      // Step 2: 组件卸载后跳过 UI 反馈
      if (!mountedRef.current) return;

      if (newCount > 0) {
        const msg = `新视频同步完成，共 ${newCount} 个`;
        if (Platform.OS === 'android') {
          ToastAndroid.show(msg, ToastAndroid.SHORT);
        } else {
          Alert.alert('同步完成', msg);
        }
      } else {
        const msg = '暂无新增视频';
        if (Platform.OS === 'android') {
          ToastAndroid.show(msg, ToastAndroid.SHORT);
        } else {
          Alert.alert('检查完毕', msg);
        }
      }
    } catch (e: any) {
      if (!mountedRef.current) return;
      const msg = e.message || '刷新失败，请稍后重试';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('刷新失败', msg);
      }
    } finally {
      // 延迟释放锁，确保 loading 动画完全过渡
      setTimeout(() => {
        refreshLockRef.current = false;
      }, 500);
    }
  }, [mediaId, refreshFolder, isRefreshing]);
  // ========== 增量刷新按钮逻辑结束 ==========

  useEffect(() => {
    setIniting(true);
    initFolder(mediaId);
    // Give it a small delay to show loading state if needed, or just set false after init
    const timer = setTimeout(() => {
      if (mountedRef.current) setIniting(false);
    }, 100);
    return () => {
      clearTimeout(timer);
    };
  }, [mediaId, initFolder]);

  const MAX_QUEUE_SIZE = 200;

  const displayedList = getDisplayedList();

  /** 后台异步加载更多分页数据并追加到播放队列尾部 */
  const loadMoreInBackground = useCallback(async () => {
    try {
      const store = useFolderDataStore.getState();
      let currentList = store.getDisplayedList();
      while (currentList.length < MAX_QUEUE_SIZE && store.hasMore) {
        await store.loadMore();
        const newState = useFolderDataStore.getState();
        currentList = newState.getDisplayedList();
      }
      // 【性能优化】页面卸载后跳过队列追加操作
      if (!mountedRef.current) return;
      const fullList = useFolderDataStore.getState().getDisplayedList();
      const playerStore = usePlayerStore.getState();
      const existingBvids = new Set(playerStore.queue.map(v => v.bvid));
      const newItems = fullList.filter(v => !existingBvids.has(v.bvid));
      if (newItems.length > 0) {
        await tpAppendQueue(newItems, playerStore.currentBvid ?? undefined);
      }
    } catch (e) {
      LoggerService.error('VideosScreen', 'loadQueueInBackground', '后台加载播放队列失败:', e);
    } finally {
      // 【性能优化】通过 InteractionManager 延迟队列加载状态的清理，
      // 避免在页面切换动画期间抢占主线程
      InteractionManager.runAfterInteractions(() => {
        usePlayerStore.getState().setQueueLoading(false);
      });
    }
  }, []);

  const playFrom = useCallback(async (idx: number) => {
    try {
      const target = displayedList[idx];
      if (!target) return;
      const context = { folderId: mediaId, sortOption, searchQuery };

      // 【修复】强制切换为顺序播放模式，避免 shuffle 模式触发大量请求
      if (usePlayerStore.getState().playMode !== 'sequential') {
        usePlayerStore.getState().setPlayMode('sequential');
      }

      // 立即使用当前已加载的列表数据构建播放队列（零网络请求）
      setQueue(displayedList, target.bvid, context);
      await loadQueue(displayedList, target.bvid);

      // 立即导航到播放器页面，消除阻塞等待感
      navigation.navigate('Player');

      // 立即开始播放当前轨道
      await TrackPlayer.play();

      // 后台异步加载更多数据并追加到队列尾部
      usePlayerStore.getState().setQueueLoading(true);
      loadMoreInBackground().catch(() => {
        usePlayerStore.getState().setQueueLoading(false);
      });
    } catch (e: any) {
      const msg = e.message || '播放失败';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('播放错误', msg);
      }
      usePlayerStore.getState().setQueueLoading(false);
    }
  }, [displayedList, mediaId, sortOption, searchQuery, loadMoreInBackground]);

  const playAll = useCallback(async () => {
    try {
      const currentList = useFolderDataStore.getState().getDisplayedList();
      if (currentList.length === 0) return;

      // 强制顺序模式
      if (usePlayerStore.getState().playMode !== 'sequential') {
        usePlayerStore.getState().setPlayMode('sequential');
      }

      const target = currentList[0];
      const context = { folderId: mediaId, sortOption, searchQuery };
      setQueue(currentList, target.bvid, context);
      await loadQueue(currentList, target.bvid);
      navigation.navigate('Player');
      await TrackPlayer.play();

      usePlayerStore.getState().setQueueLoading(true);
      loadMoreInBackground().catch(() => {
        usePlayerStore.getState().setQueueLoading(false);
      });
    } catch (e: any) {
      const msg = e.message || '播放全部失败';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('播放错误', msg);
      }
      usePlayerStore.getState().setQueueLoading(false);
    }
  }, [displayedList, playFrom]);

  const shuffle = useCallback(async () => {
    try {
      // 使用 O(1) 随机获取
      const shuffled = await favoriteService.getRandomVideos(mediaId.toString(), 100);
      if (shuffled.length === 0) return;
      
      const target = shuffled[0];
      const context = { folderId: mediaId, sortOption, searchQuery };
      
      usePlayerStore.getState().setPlayMode('shuffle');
      setQueue(shuffled, target.bvid, context);
      await loadQueue(shuffled, target.bvid);
      await TrackPlayer.play();
      navigation.navigate('Player');
    } catch (e: any) {
      const msg = e.message || '随机播放失败';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('播放错误', msg);
      }
    }
  }, [displayedList, playFrom]);

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    actions: {
      flexDirection: 'row',
      padding: t.spacing.lg,
      gap: t.spacing.md,
    },
    actionBtn: { flex: 1 },
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: t.colors.surfaceHigh,
      borderRadius: 20,
      paddingHorizontal: t.spacing.md,
      height: 40,
      marginHorizontal: t.spacing.lg,
      marginVertical: t.spacing.md,
    },
    item: {
      flexDirection: 'row',
      paddingHorizontal: t.spacing.lg,
      paddingVertical: t.spacing.md,
    },
    cover: {
      width: 112,
      height: 70,
      borderRadius: t.radius.sm,
      backgroundColor: t.colors.surfaceHigh,
    },
    info: { flex: 1, marginLeft: t.spacing.md, justifyContent: 'space-between' },
    title: { fontSize: t.fontSize.base, color: t.colors.text },
    meta: { flexDirection: 'row', justifyContent: 'space-between' },
    upper: { fontSize: t.fontSize.xs, color: t.colors.textSub },
    duration: { fontSize: t.fontSize.xs, color: t.colors.textHint },
    footer: { padding: t.spacing.lg, alignItems: 'center' },
    modalOverlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    modalContent: {
      backgroundColor: t.colors.background,
      borderTopLeftRadius: 12,
      borderTopRightRadius: 12,
      padding: t.spacing.lg,
      maxHeight: '80%',
    },
    modalTitle: {
      fontSize: t.fontSize.lg,
      fontWeight: '600',
      marginBottom: t.spacing.md,
      textAlign: 'center',
    },
  });

  // No longer using cycleSort, sorting handled via modal

  return (
    // 【性能优化】collapsable=false 确保 Android 上屏幕容器不被 View 融合优化
    <View style={s.container} {...(Platform.OS === 'android' ? { collapsable: false as any } : {})}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <Header title={`${title}`} showBack />
      {/* 搜索 + 排序栏 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.md}}>
        <View style={[s.searchBar, { flex: 1 }]}>
          <Icon name="magnify" size={20} color={t.colors.textHint} />
          <TextInput
            style={{ flex: 1, marginLeft: t.spacing.sm, color: isSearchDisabled ? t.colors.textHint : t.colors.text, fontSize: t.fontSize.base, padding: 0 }}
            placeholder={isSyncing ? "索引同步中，暂不可搜索" : isGlobalIndexEmpty ? "全局索引为空，暂不可搜索" : "搜索收藏夹内歌曲"}
            placeholderTextColor={t.colors.textHint}
            value={searchQuery}
            onChangeText={setSearchQuery} editable={!isSearchDisabled}
          />
        </View>
        {/* 增量刷新按钮：点击触发单收藏夹增量同步 */}
        {isRefreshing ? (
          <ActivityIndicator
            size="small"
            color={t.colors.primary}
            style={{ marginLeft: t.spacing.sm, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' }}
          />
        ) : (
          <IconButton
            name="refresh"
            size={24}
            color={t.colors.text}
            style={{ marginLeft: t.spacing.sm }}
            disabled={isSearchDisabled || isRefreshing}
            onPress={handleRefresh}
          />
        )}
        <IconButton name="sort-variant" size={24} color={t.colors.text} style={{ marginLeft: t.spacing.sm }} disabled={isSearchDisabled} onPress={() => setSortModalVisible(true)} />
      </View>

      {initing ? (
        <Loading />
      ) : error && displayedList.length === 0 ? (
        <ErrorView message={error} onRetry={loadMore} />
      ) : displayedList.length === 0 ? (
        <Empty title="收藏夹是空的" />
      ) : (
        <FlatList
          data={displayedList}
          keyExtractor={(it) => it.bvid}
          showsVerticalScrollIndicator={false}
          // ========== 性能优化参数 ==========
          removeClippedSubviews={true}
          maxToRenderPerBatch={10}
          windowSize={5}
          initialNumToRender={10}
          // =================================
          ListHeaderComponent={
            <View style={s.actions}>
              <Button title="全部播放" onPress={playAll} style={s.actionBtn} />
              <Button title="随机播放" variant="secondary" onPress={shuffle} style={s.actionBtn} />
            </View>
          }
          renderItem={({ item, index }) => (
            <VideoItem
              item={item}
              index={index}
              onPlay={playFrom}
              onMenu={(v) => { setSelectedVideo(v); setModalVisible(true); }}
              coverColor={t.colors.surfaceHigh}
              textColor={t.colors.text}
              textHintColor={t.colors.textHint}
              surfaceHighColor={t.colors.surfaceHigh}
              fontSizeBase={t.fontSize.base}
              fontSizeSm={t.fontSize.sm}
              spacingSm={t.spacing.sm}
              spacingMd={t.spacing.md}
              spacingLg={t.spacing.lg}
            />
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
      {/* Bottom Action Modal */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <Text style={s.modalTitle} numberOfLines={1}>{selectedVideo?.title}</Text>
            <Button
              title="下一首播放"
              variant="secondary"
              onPress={() => {
                if (selectedVideo) {
                  insertNext(selectedVideo);
                  if (Platform.OS === 'android') {
                    ToastAndroid.show('已添加到下一首播放', ToastAndroid.SHORT);
                  }
                }
                setModalVisible(false);
              }}
              style={{ marginBottom: t.spacing.sm, height: 36 }}
            />
            <Button title="取消" variant="secondary" onPress={() => setModalVisible(false)} />
          </View>
        </View>
      </Modal>
      {/* 排序弹窗 */}
      <Modal
        visible={sortModalVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setSortModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalContent}>
            <Text style={s.modalTitle}>排序方式</Text>
            <Button title="标题正序" variant="secondary" onPress={() => { setSortOption(SortOption.TitleAsc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="标题逆序" variant="secondary" onPress={() => { setSortOption(SortOption.TitleDesc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="时长正序" variant="secondary" onPress={() => { setSortOption(SortOption.DurationAsc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="时长逆序" variant="secondary" onPress={() => { setSortOption(SortOption.DurationDesc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="收藏时间正序" variant="secondary" onPress={() => { setSortOption(SortOption.FavoriteTimeAsc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="收藏时间逆序" variant="secondary" onPress={() => { setSortOption(SortOption.FavoriteTimeDesc); setSortModalVisible(false); }} style={{ marginBottom: t.spacing.sm, height: 36 }} />
            <Button title="关闭" variant="secondary" onPress={() => setSortModalVisible(false)} />
          </View>
        </View>
      </Modal>
      <MiniPlayer />
    </View>
  );
};
