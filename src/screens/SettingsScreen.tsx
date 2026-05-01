import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Alert, TextInput,
} from 'react-native';
import { Header } from '../components/Header';
import { ListItem } from '../components/ListItem';
import { Switch } from '../components/Switch';
import { useSettingsStore } from '../store/settingsStore';
import { audioCache } from '../services/audioCache';
import { cookieService } from '../services';
import { formatBytes } from '../utils/format';
import { useTheme } from '../theme';
import type { Quality } from '../types/domain';

const QUALITY_OPTIONS: Array<{ key: Quality; title: string; subtitle: string }> = [
  { key: 'low', title: '省流', subtitle: '64 kbps，约 1.9MB / 4 分钟' },
  { key: 'medium', title: '标准', subtitle: '132 kbps，约 3.8MB / 4 分钟' },
  { key: 'high', title: '高音质', subtitle: '192 kbps，约 5.5MB / 4 分钟' },
];

export const SettingsScreen = () => {
  const t = useTheme();
  const {
    quality, autoCacheOnWifi, wifiOnly,
    setQuality, setAutoCacheOnWifi, setWifiOnly,
  } = useSettingsStore();

  const [cacheSize, setCacheSize] = useState(0);
  const [cacheCount, setCacheCount] = useState(0);
  const [cookie, setCookie] = useState(cookieService.get());

  const refresh = () => {
    setCacheSize(audioCache.getTotalSize());
    setCacheCount(audioCache.getCount());
  };

  useEffect(() => { refresh(); }, []);

  const onClear = () => {
    Alert.alert('确认清空', '将删除所有已缓存的音频文件', [
      { text: '取消' },
      {
        text: '清空', style: 'destructive',
        onPress: async () => { await audioCache.clearAll(); refresh(); },
      },
    ]);
  };

  const onSaveCookie = () => {
    cookieService.set(cookie);
    Alert.alert('已保存', '已清除相关缓存，重新进入收藏夹将使用新身份');
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
      <Header title="设置" showBack />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <Text style={s.section}>音质</Text>
        <View style={s.group}>
          {QUALITY_OPTIONS.map((opt, i) => (
            <React.Fragment key={opt.key}>
              {i > 0 && <View style={s.sep} />}
              <ListItem
                title={opt.title}
                subtitle={opt.subtitle}
                onPress={() => setQuality(opt.key)}
                right={
                  quality === opt.key ? (
                    <Text style={{ color: t.colors.primary, fontSize: 18 }}>✓</Text>
                  ) : null
                }
              />
            </React.Fragment>
          ))}
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

        <Text style={s.section}>缓存</Text>
        <View style={s.group}>
          <ListItem
            title="已缓存音频"
            right={
              <Text style={{ color: t.colors.textSub, fontSize: t.fontSize.sm }}>
                {cacheCount} / {formatBytes(cacheSize)}
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

        <Text style={s.section}>登录（可选）</Text>
        <View style={[s.group, s.cookieBox]}>
          <Text style={{ fontSize: t.fontSize.base, color: t.colors.text, marginBottom: t.spacing.sm }}>
            SESSDATA Cookie
          </Text>
          <TextInput
            style={s.input}
            value={cookie}
            onChangeText={setCookie}
            placeholder="SESSDATA=xxxxxxxxxx"
            placeholderTextColor={t.colors.textHint}
            multiline
            secureTextEntry
          />
          <Text style={s.cookieHint}>
            用于加载私密收藏夹和高音质。从浏览器 F12 → Application → Cookie 中复制 SESSDATA
          </Text>
          <Text style={s.saveText} onPress={onSaveCookie}>保存</Text>
        </View>

        <Text style={s.section}>关于</Text>
        <View style={s.group}>
          <ListItem title="版本号" right={<Text style={{ color: t.colors.textSub }}>v1.0.0</Text>} />
          <View style={s.sep} />
          <ListItem title="开源协议" subtitle="本应用仅供个人学习使用" />
        </View>
      </ScrollView>
    </View>
  );
};
