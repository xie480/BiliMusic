import React, { useEffect } from 'react';
import {
  View, Text, StyleSheet, KeyboardAvoidingView, Platform, StatusBar, Image
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from '../components/Button';
import { useAuthStore } from '../store/authStore';
import { useUIStore } from '../store/uiStore';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const HomeScreen = ({ navigation }: any) => {
  const t = useTheme();
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const setLoginModalVisible = useUIStore((s) => s.setLoginModalVisible);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (loggedIn) {
      navigation.replace('Folders');
    }
  }, [loggedIn, navigation]);

  const onLogin = () => {
    setLoginModalVisible(true);
  };

  const paddingTop = Platform.OS === 'android' ? Math.max(insets.top, StatusBar.currentHeight ?? 0) : insets.top;

  const s = StyleSheet.create({
    container: {
      flex: 1,
      padding: t.spacing.lg,
      paddingTop,
      backgroundColor: t.colors.background,
      justifyContent: 'center',
      alignItems: 'center',
    },
    iconWrap: {
      width: 80, height: 80, borderRadius: 20, backgroundColor: t.colors.primaryLight,
      alignSelf: 'center', alignItems: 'center', justifyContent: 'center',
      marginBottom: t.spacing.xl,
    },
    title: {
      fontSize: t.fontSize.xxl, fontWeight: 'bold',
      color: t.colors.text, textAlign: 'center',
    },
    subtitle: {
      fontSize: t.fontSize.sm, color: t.colors.textSub,
      textAlign: 'center', marginTop: t.spacing.sm, marginBottom: t.spacing.xxl,
    },
    enter: { marginTop: t.spacing.xxl },
    settingsBtn: { alignSelf: 'center', marginTop: t.spacing.xl },
    settingsBtnText: { color: t.colors.textSub, fontSize: t.fontSize.sm },
  });

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
      <View style={s.iconWrap}>
        <Image source={require('../../resource/icon.png')} style={{ width: 100, height: 100 }} />
      </View>
      <Text style={s.title}>Nyami</Text>
      <Text style={s.subtitle}>猫在听，你也在听</Text>
      <Button title="立即登录" onPress={onLogin} style={s.enter} />
      <Text
        style={[s.settingsBtnText, s.settingsBtn]}
        onPress={() => navigation.navigate('Settings')}
      >
        设置
      </Text>
    </KeyboardAvoidingView>
  </View>
  );
};
