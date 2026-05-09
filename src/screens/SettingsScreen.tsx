import React, { useEffect, useState, useCallback } from 'react';
import { View, StatusBar, Image, Dimensions, Linking, Alert, Platform, ToastAndroid } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  Text, ScrollView, StyleSheet,
} from 'react-native';
import { Header } from '../components/Header';
import { Dialog } from '../components/Dialog';
import { ListItem } from '../components/ListItem';
import { Switch } from '../components/Switch';
import { Button } from '../components/Button';
import LoggerService from '../services/LoggerService';
import { useSettingsStore } from '../store/settingsStore';
import type { ThemeMode } from '../store/settingsStore';
// Removed useUserStore - authentication now handled by authStore
import { useSyncStore } from '../store/syncStore';
import { Slider } from '../components/Slider';
import { audioCache } from '../services/audioCache';
import { favoriteService, cookieService } from '../services';
import { useAuthStore } from '../store/authStore';
import { biliApi } from '../services/biliApi';
import { useUIStore } from '../store/uiStore';
import { formatBytes } from '../utils/format';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Quality } from '../types/domain';
import ImageCropPicker from 'react-native-image-crop-picker';
import RNFS from 'react-native-fs';

const QUALITY_OPTIONS: Array<{
  key: Quality;
  title: string;
  subtitle: string;
  /** 是否需要大会员 */
  requiresVip?: boolean;
}> = [
  { key: 'hires', title: 'HI-FES 无损', subtitle: '无损音频 · 最高音质', requiresVip: true },
  { key: 'dolby', title: '杜比全景声', subtitle: '沉浸式环绕声体验', requiresVip: true },
  { key: 'high', title: '高音质', subtitle: '192 kbps' },
  { key: 'medium', title: '标准', subtitle: '132 kbps' },
  { key: 'low', title: '省流', subtitle: '64 kbps' },
];

const THEME_OPTIONS: Array<{ key: ThemeMode; title: string }> = [
  { key: 'system', title: '跟随系统' },
  { key: 'light', title: '明亮' },
  { key: 'dark', title: '暗黑' },
  { key: 'glass-light', title: '磨砂玻璃（明亮）' },
  { key: 'glass-dark', title: '磨砂玻璃（暗黑）' },
];

export const SettingsScreen = ({ navigation }: any) => {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const {
    quality, autoCacheOnWifi, wifiOnly, hiddenFolderIds,
    expandMultiPart, themeMode, customBackgroundImage, glassBlurAmount,
    setQuality, setAutoCacheOnWifi,
    setWifiOnly, setExpandMultiPart, setThemeMode,
    setCustomBackgroundImage, setGlassBlurAmount,
  } = useSettingsStore();
  // UID management moved to authStore (userId, userInfo)

  const isGlass = themeMode === 'glass-light' || themeMode === 'glass-dark';

  const [cacheSize, setCacheSize] = useState(0);
  const [cacheCount, setCacheCount] = useState(0);
  const { syncStatus, progressData, syncError, startSync, abortSync, resetSyncState } = useSyncStore();
  const [globalIndexCount, setGlobalIndexCount] = useState(0);

  const [dialogConfig, setDialogConfig] = useState<{
    visible: boolean;
    title?: string;
    message?: string;
    actions?: Array<{ text: string; onPress?: () => void; style?: 'default' | 'cancel' | 'destructive' }>;
  }>({ visible: false });

  const showDialog = useCallback((title: string, message: string, actions?: any[]) => {
    setDialogConfig({ visible: true, title, message, actions });
  }, []);

  const hideDialog = useCallback(() => {
    setDialogConfig(prev => ({ ...prev, visible: false }));
  }, []);

  // Auth state
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const userId = useAuthStore((s) => s.userId);
  const userInfo = useAuthStore((s) => s.userInfo);
  const isVip = useAuthStore((s) => s.isVip);
  const logout = useAuthStore((s) => s.logout);
  const setUserInfo = useAuthStore((s) => s.setUserInfo);
  const setLoginModalVisible = useUIStore((s) => s.setLoginModalVisible);

  // 音质选择逻辑（VIP 验证）
  const handleQualitySelect = useCallback((opt: typeof QUALITY_OPTIONS[number]) => {
    if (opt.requiresVip && !loggedIn) {
      showDialog('提示', '请先登录后再选择该音质');
      return;
    }
    if (opt.requiresVip && !isVip) {
      showDialog('大会员专享', `「${opt.title}」需要开通 B 站大会员后方可使用`);
      return;
    }
    setQuality(opt.key);
  }, [loggedIn, isVip, setQuality, showDialog]);
  const triggerLogin = () => setLoginModalVisible(true);
  const handleLogout = async () => {
    await logout();
    setLoginModalVisible(false);
    navigation.replace('Home');
  };

  useFocusEffect(
    useCallback(() => {
      const currentStatus = useSyncStore.getState().syncStatus;
      if (currentStatus === 'done' || currentStatus === 'error') {
        resetSyncState();
      }
    }, [resetSyncState])
  );

  const refresh = () => {
    setCacheSize(audioCache.getTotalSize());
    setCacheCount(audioCache.getCount());
  };

  useEffect(() => {
    refresh();
    setGlobalIndexCount(favoriteService.getGlobalIndex().length);
  }, []);

  useEffect(() => {
    if (syncStatus === 'done') {
      setGlobalIndexCount(favoriteService.getGlobalIndex().length);
    }
  }, [syncStatus]);

  const handlePickBackground = useCallback(async () => {
    try {
      const { width, height } = Dimensions.get('window');
      // 使用最大公约数简化宽高比，避免裁剪尺寸过大
      const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
      const divisor = gcd(Math.round(width), Math.round(height));
      const baseW = Math.round(width / divisor);
      const baseH = Math.round(height / divisor);
      // 放大 100 倍以确保精度，同时避免像素值过大
      const cropWidth = baseW * 100;
      const cropHeight = baseH * 100;
      const image = await ImageCropPicker.openPicker({
        mediaType: 'photo',
        cropping: true,
        width: cropWidth,
        height: cropHeight,
        cropperCircleOverlay: false,
        freeStyleCropEnabled: false,
        compressImageQuality: 1,
      });
      if (!image.path) return;
      const destDir = `${RNFS.DocumentDirectoryPath}/backgrounds`;
      const exists = await RNFS.exists(destDir);
      if (!exists) {
        await RNFS.mkdir(destDir);
      } else {
        const files = await RNFS.readDir(destDir);
        for (const file of files) {
          if (file.name.startsWith('custom_bg_')) {
            await RNFS.unlink(file.path).catch(() => {});
          }
        }
      }
      const ext = (image.path.split('.').pop() ?? 'jpg').toLowerCase();
      const destPath = `${destDir}/custom_bg_${Date.now()}.${ext}`;
      await RNFS.copyFile(image.path, destPath);
      setCustomBackgroundImage(`file://${destPath}`);
    } catch (e: any) {
      if (e?.code === 'E_PICKER_CANCELLED' || e?.message === 'User cancelled image selection') {
        // 用户取消，什么都不做
      } else {
        showDialog('错误', '背景图导入失败，请重试');
      }
    }
  }, [setCustomBackgroundImage, showDialog]);

  const handleClearBackground = useCallback(() => {
    showDialog('重置背景图', '确定要恢复默认背景吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '重置', style: 'destructive',
        onPress: () => setCustomBackgroundImage(null),
      },
    ]);
  }, [setCustomBackgroundImage, showDialog]);

  const onClear = () => {
    showDialog('确认清空', '将删除所有已缓存的音频文件', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空', style: 'destructive',
        onPress: async () => { await audioCache.clearAll(); refresh(); },
      },
    ]);
  };

  const onSyncGlobalIndex = () => {
    if (!userId) {
      showDialog('提示', '请先登录');
      return;
    }
    // 传入 hiddenFolderIds，仅同步用户选中的收藏夹
    // 默认进行增量同步，除非需要强制全量同步，传入 force 参数为 true
    startSync(userId, hiddenFolderIds);
  };

  const s = StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    section: {
      fontSize: t.fontSize.sm, color: t.colors.textSub,
      marginTop: t.spacing.xxl, marginBottom: t.spacing.sm,
      marginHorizontal: t.spacing.lg,
    },
    group: {
      marginHorizontal: t.spacing.lg,
      borderRadius: t.radius.lg, overflow: 'hidden',
      backgroundColor: t.colors.surface,
    },
    sep: { height: 0.5, backgroundColor: t.colors.divider, marginLeft: t.spacing.lg },
    cookieBox: { padding: t.spacing.lg, backgroundColor: t.colors.surface },
    input: {
      borderWidth: 1, borderColor: t.colors.divider, borderRadius: t.radius.md,
      paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.sm,
      fontSize: t.fontSize.sm, color: t.colors.text, minHeight: 40,
    },
    cookieHint: { fontSize: t.fontSize.xs, color: t.colors.textHint, marginTop: t.spacing.sm },
    saveText: {
      color: t.colors.primary, marginTop: t.spacing.sm,
      fontSize: t.fontSize.base, textAlign: 'right',
    },
    danger: { color: t.colors.error, fontSize: t.fontSize.base },
  });

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <Header title="设置" showBack noBorder />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
      <Text style={s.section}>账户</Text>
      <View style={[s.group, s.cookieBox]}>
        {loggedIn && userInfo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Image source={{ uri: userInfo.avatar }} style={{ width: 40, height: 40, borderRadius: 20, marginRight: t.spacing.md }} />
              <View>
                <Text style={{ fontSize: t.fontSize.base, color: t.colors.text }}>{userInfo.name}</Text>
                <Text style={{ fontSize: t.fontSize.sm, color: t.colors.textSub }}>UID: {userInfo.uid}</Text>
              </View>
            </View>
            <Text style={s.saveText} onPress={handleLogout}>退出登录</Text>
          </View>
        ) : (
          <Text style={s.saveText} onPress={triggerLogin}>点击登录</Text>
        )}
      </View>
        <Text style={s.section}>UI</Text>
        {isGlass && (
          <>
            <View style={s.group}>
              <ListItem
                title="自定义背景图"
                subtitle={customBackgroundImage ? '已设置 · 点击更换' : '导入个性化背景图片'}
                onPress={handlePickBackground}
                right={
                  customBackgroundImage ? (
                    <Text style={{ color: t.colors.primary, fontSize: t.fontSize.sm }} onPress={handleClearBackground}>重置</Text>
                  ) : (
                    <Text style={{ color: t.colors.primary, fontSize: 18 }}>+</Text>
                  )
                }
              />
            </View>
            <View style={{ height: t.spacing.lg }} />
          </>
        )}
        <View style={s.group}>
          {THEME_OPTIONS.map((opt, i) => (
            <React.Fragment key={opt.key}>
              {i > 0 && <View style={s.sep} />}
              <ListItem
                title={opt.title}
                onPress={() => setThemeMode(opt.key)}
                right={
                  themeMode === opt.key ? (
                    <Text style={{ color: t.colors.primary, fontSize: 18 }}>✓</Text>
                  ) : null
                }
              />
            </React.Fragment>
          ))}
        </View>

        {isGlass && (
          <>
            <View style={{ height: t.spacing.lg }} />
            <View style={s.group}>
              <View style={{ padding: t.spacing.lg }}>
                <Text style={{ fontSize: t.fontSize.sm, color: t.colors.text, marginBottom: t.spacing.sm }}>
                  背景模糊度：{glassBlurAmount}
                </Text>
                <Slider
                  value={glassBlurAmount}
                  minimumValue={0}
                  maximumValue={100}
                  step={1}
                  onValueChange={setGlassBlurAmount}
                  minimumTrackColor={t.colors.primary}
                  maximumTrackColor={t.colors.divider}
                  thumbColor={t.colors.primary}
                />
              </View>
            </View>
          </>
        )}

        <Text style={s.section}>音效</Text>
        <View style={s.group}>
          <ListItem
            title="声音实验室"
            subtitle="双层 EQ 与动态频谱"
            onPress={() => navigation.navigate('SoundLab')}
            showArrow
          />
        </View>

        <Text style={s.section}>音质</Text>
        <View style={s.group}>
          {QUALITY_OPTIONS.map((opt, i) => {
            const isVipLocked = opt.requiresVip && !isVip;
            const isSelected = quality === opt.key;
            return (
              <React.Fragment key={opt.key}>
                {i > 0 && <View style={s.sep} />}
                <View style={{ opacity: isVipLocked ? 0.45 : 1 }}>
                  <ListItem
                    title={opt.title}
                    subtitle={opt.subtitle}
                    onPress={() => handleQualitySelect(opt)}
                    right={
                      isVipLocked ? (
                        <Text style={{ fontSize: 16 }}>🔒</Text>
                      ) : isSelected ? (
                        <Text style={{ color: t.colors.primary, fontSize: 18 }}>✓</Text>
                      ) : null
                    }
                  />
                </View>
              </React.Fragment>
            );
          })}
        </View>

        <Text style={s.section}>流量</Text>
        <View style={s.group}>
          <ListItem
            title="仅 WiFi 下加载"
            right={<Switch value={wifiOnly} onValueChange={setWifiOnly} />}
          />
          <View style={s.sep} />
          <ListItem
            title="WiFi 下自动缓存已播放音频"
            right={<Switch value={autoCacheOnWifi} onValueChange={setAutoCacheOnWifi} />}
          />
        </View>

        <Text style={s.section}>播放</Text>
        <View style={s.group}>
          <ListItem
            title="将分P列表加入播放列表"
            right={<Switch value={expandMultiPart} onValueChange={setExpandMultiPart} />}
          />
        </View>

        <Text style={s.section}>全局索引</Text>
        <View style={s.group}>
          <ListItem
            title="可见收藏夹偏好"
            onPress={() => navigation.navigate('VisibleFolders')}
            showArrow
          />
          <View style={s.sep} />
          <ListItem
            title="同步全局索引"
            subtitle={
              syncStatus === 'syncing'
                ? progressData
                  ? `${progressData.completedTasks}/${progressData.totalTasks} 任务, ${progressData.processedVideos}/${progressData.totalVideos} 视频`
                  : '正在获取收藏夹列表...'
                : syncStatus === 'error'
                ? `同步失败: ${syncError}`
                : syncStatus === 'done'
                ? `同步完成 (${globalIndexCount}/${progressData?.totalVideos ?? globalIndexCount} 视频)`
                : `当前已索引 ${globalIndexCount} 个视频`
            }
            onPress={syncStatus === 'syncing' ? undefined : onSyncGlobalIndex}
            right={
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Button title="查看" variant="text" onPress={() => navigation.navigate('SyncDetails')} />
                {syncStatus === 'syncing' ? (
                  <Button title="取消" variant="text" onPress={abortSync} />
                ) : syncStatus === 'error' ? (
                  <Text style={{ color: t.colors.error, fontSize: t.fontSize.base, marginLeft: t.spacing.sm }}>重试</Text>
                ) : (
                  <Text style={{ color: t.colors.primary, fontSize: t.fontSize.base, marginLeft: t.spacing.sm }}>开始同步</Text>
                )}
              </View>
            }
          />
          {syncStatus === 'syncing' && (
            <View style={{ paddingHorizontal: t.spacing.lg, paddingBottom: t.spacing.md }}>
              <View style={{ height: 4, backgroundColor: t.colors.divider, borderRadius: 2, overflow: 'hidden' }}>
                <View
                  style={{
                    height: '100%',
                    backgroundColor: t.colors.primary,
                    width: progressData ? `${(progressData.processedVideos / Math.max(1, progressData.totalVideos)) * 100}%` : '0%',
                  }}
                />
              </View>
              <Text style={{ color: t.colors.textHint, fontSize: t.fontSize.xs, marginTop: t.spacing.sm }}>
                · B站限流可能导致同步较慢，请耐心等待
                · 建议在WIFI环境下完成同步，避免中途停止
                · 最终结果可能因失效视频与总数存在差异
              </Text>
            </View>
          )}
        </View>

        <Text style={s.section}>缓存</Text>
        <View style={s.group}>
          <ListItem
            title="已缓存音频"
            right={
              <Text style={{ color: t.colors.textSub, fontSize: t.fontSize.sm }}>
                {cacheCount}首 / {formatBytes(cacheSize)}
              </Text>
            }
          />
          <View style={s.sep} />
          <ListItem
            title="清空全部缓存"
            onPress={onClear}
            right={<Text style={s.danger}>清空</Text>}
          />
        </View>


        <Text style={s.section}>日志</Text>
        <View style={s.group}>
          <ListItem
            title="导出运行日志"
            subtitle="将应用运行期间的日志导出为文件进行查看"
            onPress={async () => {
              const success = await LoggerService.exportLogs();
              if (!success) {
                const msg = '暂无日志数据可导出';
                if (Platform.OS === 'android') {
                  ToastAndroid.show(msg, ToastAndroid.SHORT);
                } else {
                  Alert.alert('提示', msg);
                }
              }
            }}
            showArrow
          />
          <View style={s.sep} />
          <ListItem
            title="删除日志文件"
            subtitle="清除本地存储的所有历史日志记录"
            onPress={() => {
              showDialog('确认删除', '确定要删除所有本地日志文件吗？\n此操作不可恢复。', [
                { text: '取消', style: 'cancel' },
                {
                  text: '删除', style: 'destructive',
                  onPress: async () => {
                    await LoggerService.clearLogs();
                    const msg = '日志文件已删除';
                    if (Platform.OS === 'android') {
                      ToastAndroid.show(msg, ToastAndroid.SHORT);
                    } else {
                      Alert.alert('提示', msg);
                    }
                  },
                },
              ]);
            }}
            right={<Text style={s.danger}>删除</Text>}
          />
        </View>

        <Text style={s.section}>关于</Text>
        <View style={s.group}>
          <ListItem title="版本号" right={<Text style={{ color: t.colors.textSub }}>v1.0.0</Text>} />
          <View style={s.sep} />
          <ListItem title="开源协议" subtitle="本应用仅供个人学习使用" />
          <View style={s.sep} />
          <ListItem
            title="项目 Github 地址"
            subtitle="如果觉得好用的话，求求给个Star~"
            onPress={() => Linking.openURL('https://github.com/xie480/Nyami.git')}
            showArrow
          />
        </View>
      </ScrollView>

      <Dialog
        visible={dialogConfig.visible}
        title={dialogConfig.title}
        message={dialogConfig.message}
        actions={dialogConfig.actions}
        onClose={hideDialog}
      />
    </View>
  );
};
