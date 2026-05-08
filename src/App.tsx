import 'react-native-gesture-handler';
import React, { useEffect, useState, useRef } from 'react';
import { useAuthStore } from './store/authStore';
import { useSettingsStore } from './store/settingsStore';
import { NavigationContainer, DefaultTheme, DarkTheme, useNavigationContainerRef } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { View, StyleSheet, useColorScheme, Alert, Platform, ToastAndroid, BackHandler, PermissionsAndroid, StatusBar } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider, useTheme } from './theme';
import LoggerService from './services/LoggerService';
import ToastNotification, { ToastNotificationRef, ToastConfig } from './components/ToastNotification';
import { setupPlayer } from './services/trackPlayer';
import { netStatus } from './services/netStatus';
import { HomeScreen } from './screens/HomeScreen';
import { FoldersScreen } from './screens/FoldersScreen';
import { VideosScreen } from './screens/VideosScreen';
import { PlayerScreen } from './screens/PlayerScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SoundLabScreen } from './screens/SoundLabScreen';
import { VisibleFoldersScreen } from './screens/VisibleFoldersScreen';
import { SplashScreen } from './screens/SplashScreen';
import { SyncDetailsScreen } from './screens/SyncDetailsScreen';
import { favoriteService, loadGlobalIndexCache } from './services/favoriteService';
import { PlaylistPanel } from './components/PlaylistPanel';
import { useUIStore } from './store/uiStore';
import { LoginModal } from './components/LoginModal';
import { storage } from './core/storage';
import { useSyncStore } from './store/syncStore';
import { GlassBackground } from './components/GlassBackground';
import { startProgressPolling, stopProgressPolling } from './store/progressStore';

const Stack = createStackNavigator();

const withBackground = (Component: React.ComponentType<any>) => {
  return function ScreenWithBackground(props: any) {
    const { colors, glass } = useTheme();
    const bgColor = glass ? 'transparent' : colors.background;
    return (
      <View style={{ flex: 1, backgroundColor: bgColor }}>
        <Component {...props} />
      </View>
    );
  };
};

const HomeScreenWithBg = withBackground(HomeScreen);
const FoldersScreenWithBg = withBackground(FoldersScreen);
const VideosScreenWithBg = withBackground(VideosScreen);
const PlayerScreenWithBg = withBackground(PlayerScreen);
const SettingsScreenWithBg = withBackground(SettingsScreen);
const SoundLabScreenWithBg = withBackground(SoundLabScreen);
const VisibleFoldersScreenWithBg = withBackground(VisibleFoldersScreen);
const SplashScreenWithBg = withBackground(SplashScreen);
const SyncDetailsScreenWithBg = withBackground(SyncDetailsScreen);

/**
 * 安全区域适配包装器
 */
const SafeAreaWrapper: React.FC<{ children: React.ReactNode; baseBgColor: string }> = ({
  children,
  baseBgColor,
}) => {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: baseBgColor,
      }}
    >
      {children}
    </View>
  );
};

export default function App() {
  const systemScheme = useColorScheme();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const isDark = themeMode === 'system' ? systemScheme === 'dark' : (themeMode === 'dark' || themeMode === 'glass-dark');
  const baseBgColor = isDark ? '#0F0F11' : '#FFFFFF';
  
  const toastRef = useRef<ToastNotificationRef>(null);
  const [isOnline, setIsOnline] = useState(true);
  const navigationRef = useNavigationContainerRef();
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const uid = useAuthStore((s) => s.userId);
  const initAuth = useAuthStore((s) => s.initAuth);
  const authReady = useAuthStore((s) => s.authReady);
  const hiddenFolderIds = useSettingsStore((s) => s.hiddenFolderIds);
  const playlistVisible = useUIStore(state => state.playlistVisible);
  const setPlaylistVisible = useUIStore(state => state.setPlaylistVisible);
  const isGlassMode = themeMode === 'glass-light' || themeMode === 'glass-dark';
  const navTheme = {
    ...(isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
      background: 'transparent',
    },
  };
  const startSync = useSyncStore(state => state.startSync);

  // 记录上一次的 hiddenFolderIds，用于检测变化
  const prevHiddenFolderIdsRef = useRef<number[]>(hiddenFolderIds);

  // Initialize player, network status listener, back handler, and Logger
  useEffect(() => {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    // 初始化全局日志服务，并绑定 Toast 通知回调
    LoggerService.init((level, message) => {
      toastRef.current?.show({
        type: level === 'ERROR' ? 'error' : 'warn',
        message,
      });
    });

    initAuth();
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

    startProgressPolling();

    return () => {
      unsubscribe();
      backHandler.remove();
      stopProgressPolling();
    };
  }, []);

  // Rebuild global index on startup or when uid changes
  useEffect(() => {
    const init = async () => {
      if (!authReady) return;
      if (uid) {
        const lastUid = storage.getString('lastUid');
        
        // 先加载缓存，确保 globalIndex 有数据
        await loadGlobalIndexCache();
        const globalIndex = favoriteService.getGlobalIndex();
        
        // 仅在切换账号时清理旧索引，用户需在设置页面手动同步
        if (lastUid !== uid) {
          // 仅清理旧数据，等待用户手动同步
          await favoriteService.clearGlobalIndex();
          storage.setString('lastUid', uid);
        }
      } else {
        // 用户登出时清理数据
        await favoriteService.clearGlobalIndex();
        storage.delete('lastUid');
      }
    };
    init();
  }, [uid, authReady]);

  // 监听 hiddenFolderIds 变化，自动触发全局索引重新同步
  // 引入 hasMountedRef 以区分首次挂载（状态恢复）和后续用户交互导致的变化
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (!uid) return;
    // 第一次渲染后（或状态恢复完成）时不触发清空全局索引
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      // 同步前一次的 hiddenFolderIds，以便后续比较
      prevHiddenFolderIdsRef.current = hiddenFolderIds;
      return;
    }
    // 跳过因相同引用导致的无效触发
    if (prevHiddenFolderIdsRef.current === hiddenFolderIds) {
      prevHiddenFolderIdsRef.current = hiddenFolderIds;
      return;
    }
    // 更新记录
    prevHiddenFolderIdsRef.current = hiddenFolderIds;

    // 用户修改了可见收藏夹偏好，重新加载全局索引缓存
    // 注意：绝不能在这里调用 clearGlobalIndex()，否则会导致增量同步退化为全量覆盖
    (async () => {
      await loadGlobalIndexCache();
    })();
    // 自动同步已移除，用户可在设置页面手动同步
  }, [hiddenFolderIds, uid]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <SafeAreaWrapper baseBgColor={baseBgColor}>
            <GlassBackground />
            <NavigationContainer ref={navigationRef} theme={navTheme}>
              <Stack.Navigator
                initialRouteName="Splash"
                screenOptions={{
                  headerShown: false,
                  cardStyle: { backgroundColor: 'transparent' },
                  animation: isGlassMode ? 'none' : 'default',
                  // 【性能优化】启用 freezeOnBlur：页面不可见时停止渲染，
                  // 配合 react-native-screens 释放 GPU/CPU 资源
                  freezeOnBlur: true,
                }}
              >
                <Stack.Screen name="Splash" component={SplashScreenWithBg} />
                <Stack.Screen name="Home" component={HomeScreenWithBg} />
                <Stack.Screen name="Folders" component={FoldersScreenWithBg} />
                <Stack.Screen name="Videos" component={VideosScreenWithBg} />
                <Stack.Screen
                  name="Player"
                  component={PlayerScreenWithBg}
                  options={{ presentation: 'modal' }}
                />
                <Stack.Screen name="Settings" component={SettingsScreenWithBg} />
                <Stack.Screen name="SoundLab" component={SoundLabScreenWithBg} />
                <Stack.Screen name="VisibleFolders" component={VisibleFoldersScreenWithBg} />
                <Stack.Screen name="SyncDetails" component={SyncDetailsScreenWithBg} />
              </Stack.Navigator>
            </NavigationContainer>
          </SafeAreaWrapper>
          {/* 全局顶部通知组件 - 覆盖在所有页面之上 */}
          <ToastNotification ref={toastRef} />
          <PlaylistPanel visible={playlistVisible} onClose={() => setPlaylistVisible(false)} />
          <LoginModal />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
