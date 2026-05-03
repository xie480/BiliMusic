import 'react-native-gesture-handler';
import React, { useEffect, useState, useRef } from 'react';
import { useUserStore } from './store/userStore';
import { useSettingsStore } from './store/settingsStore';
import { NavigationContainer, DefaultTheme, DarkTheme, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme, Alert, Platform, ToastAndroid, BackHandler } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider } from './theme';
import { setupPlayer } from './services/trackPlayer';
import { netStatus } from './services/netStatus';
import { HomeScreen } from './screens/HomeScreen';
import { FoldersScreen } from './screens/FoldersScreen';
import { VideosScreen } from './screens/VideosScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { VisibleFoldersScreen } from './screens/VisibleFoldersScreen';
import { favoriteService } from './services/favoriteService';
import { PlaylistPanel } from './components/PlaylistPanel';
import { useUIStore } from './store/uiStore';

const Stack = createNativeStackNavigator();

export default function App() {
  const isDark = useColorScheme() === 'dark';
  const [isOnline, setIsOnline] = useState(true);
  const navigationRef = useNavigationContainerRef();
  const uid = useUserStore((s) => s.uid);
  const hiddenFolderIds = useSettingsStore((s) => s.hiddenFolderIds);
  const playlistVisible = useUIStore(state => state.playlistVisible);
  const setPlaylistVisible = useUIStore(state => state.setPlaylistVisible);

  // 记录上一次的 hiddenFolderIds，用于检测变化
  const prevHiddenFolderIdsRef = useRef<number[]>(hiddenFolderIds);

  // Initialize player, network status listener, and back handler
  useEffect(() => {
    setupPlayer();
    netStatus.init();
    const unsubscribe = netStatus.onChange((type) => {
      const nowOnline = type !== 'none';
      setIsOnline(nowOnline);
      if (!nowOnline) {
        const message = '网络已断开，当前仅可播放本地缓存音频';
        if (Platform.OS === 'android') {
          ToastAndroid.show(message, ToastAndroid.LONG);
        } else {
          Alert.alert('网络断开', message);
        }
      }
    });

    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigationRef.isReady() && navigationRef.canGoBack()) {
        navigationRef.goBack();
        return true;
      }
      return false;
    });

    return () => {
      unsubscribe();
      backHandler.remove();
    };
  }, []);

  // Rebuild global index on startup or when uid changes
  useEffect(() => {
    if (uid) {
      favoriteService.clearGlobalIndex();
      favoriteService.syncGlobalIndex(uid, hiddenFolderIds).catch(console.warn);
    }
  }, [uid]);

  // 监听 hiddenFolderIds 变化，自动触发全局索引重新同步
  useEffect(() => {
    if (!uid) return;
    // 跳过首次渲染（由 uid effect 处理）
    if (prevHiddenFolderIdsRef.current === hiddenFolderIds) {
      prevHiddenFolderIdsRef.current = hiddenFolderIds;
      return;
    }
    prevHiddenFolderIdsRef.current = hiddenFolderIds;

    // 用户修改了可见收藏夹偏好，重新构建全局索引
    favoriteService.clearGlobalIndex();
    favoriteService.syncGlobalIndex(uid, hiddenFolderIds).catch(console.warn);
  }, [hiddenFolderIds, uid]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <NavigationContainer ref={navigationRef} theme={isDark ? DarkTheme : DefaultTheme}>
            <Stack.Navigator
              initialRouteName={uid ? 'Folders' : 'Home'}
              screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
            >
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Folders" component={FoldersScreen} />
              <Stack.Screen name="Videos" component={VideosScreen} />
              <Stack.Screen
                name="Player"
                component={PlayerScreen}
                options={{ animation: 'slide_from_bottom', presentation: 'modal' }}
              />
              <Stack.Screen name="Settings" component={SettingsScreen} />
              <Stack.Screen name="VisibleFolders" component={VisibleFoldersScreen} />
            </Stack.Navigator>
          </NavigationContainer>
          <PlaylistPanel visible={playlistVisible} onClose={() => setPlaylistVisible(false)} />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
