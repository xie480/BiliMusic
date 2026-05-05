import React, { useEffect, useState, useCallback, useRef } from 'react';
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
} from 'react-native';
import FastImage from 'react-native-fast-image';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import TrackPlayer from 'react-native-track-player';
import { IconButton } from '../components/IconButton';
import { SafeAreaView, StatusBar } from 'react-native';
import { Header } from '../components/Header';
import { Loading } from '../components/Loading';
import { Empty } from '../components/Empty';
import { ErrorView } from '../components/ErrorView';
import { MiniPlayer } from '../components/MiniPlayer';
import { Button } from '../components/Button';
import { favoriteService } from '../services';
import { loadQueue, insertNext } from '../services/trackPlayer';
import { usePlayerStore } from '../store/playerStore';
import { formatDuration } from '../utils/format';
import { useTheme } from '../theme';
import { useSyncStore } from '../store/syncStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { FavoriteVideo } from '../types/domain';
import { useFolderDataStore, SortOption } from '../store/folderDataStore';

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

  useEffect(() => {
    setIniting(true);
    initFolder(mediaId);
    // Give it a small delay to show loading state if needed, or just set false after init
    setTimeout(() => setIniting(false), 100);
  }, [mediaId, initFolder]);

  const ensureAllLoaded = async () => {
    let currentHasMore = useFolderDataStore.getState().hasMore;
    while (currentHasMore) {
      await useFolderDataStore.getState().loadMore();
      currentHasMore = useFolderDataStore.getState().hasMore;
    }
  };

  const displayedList = getDisplayedList();

  const playFrom = async (idx: number) => {
    try {
      const target = displayedList[idx];
      const context = { folderId: mediaId, sortOption, searchQuery };
      
      if (playMode === 'shuffle') {
        // 拦截手动点歌：在随机模式下重新洗牌并将点击歌曲置顶
        if (hasMore) await ensureAllLoaded();
        const fullList = useFolderDataStore.getState().getDisplayedList();
        const targetIndex = fullList.findIndex(v => v.bvid === target.bvid);
        
        let shuffled = [...fullList];
        if (targetIndex !== -1) {
          shuffled.splice(targetIndex, 1);
        }
        
        // Fisher-Yates shuffle
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        
        shuffled.unshift(target);
        setQueue(shuffled, target.bvid, context);
        await loadQueue(shuffled, target.bvid);
      } else {
        setQueue(displayedList, target.bvid, context);
        await loadQueue(displayedList, target.bvid);
      }
      
      await TrackPlayer.play();
      navigation.navigate('Player');
    } catch (e: any) {
      const msg = e.message || '播放失败';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('播放错误', msg);
      }
    }
  };

  const playAll = async () => {
    try {
      if (hasMore) await ensureAllLoaded();
      await playFrom(0);
    } catch (e: any) {
      const msg = e.message || '播放全部失败';
      if (Platform.OS === 'android') {
        ToastAndroid.show(msg, ToastAndroid.SHORT);
      } else {
        Alert.alert('播放错误', msg);
      }
    }
  };

  const shuffle = async () => {
    try {
      if (hasMore) await ensureAllLoaded();
      const fullList = useFolderDataStore.getState().getDisplayedList();
      if (fullList.length === 0) return;
      
      const shuffled = [...fullList];
      // Fisher-Yates shuffle
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      
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
  };

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
    <SafeAreaView style={[s.container, { paddingTop: insets.top }]}>
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
          ListHeaderComponent={
            <View style={s.actions}>
              <Button title="全部播放" onPress={playAll} style={s.actionBtn} />
              <Button title="随机播放" variant="secondary" onPress={shuffle} style={s.actionBtn} />
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
              <IconButton name="dots-vertical" size={24} color={t.colors.text}
                onPress={() => {
                  setSelectedVideo(item);
                  setModalVisible(true);
                }} />
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
    </SafeAreaView>
  );
};
