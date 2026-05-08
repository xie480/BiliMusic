import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, StatusBar, Image, Platform } from 'react-native';
import { useAuthStore } from '../store/authStore';
import { useTheme } from '../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const SplashScreen = ({ navigation }: any) => {
  const t = useTheme();
  const authReady = useAuthStore((s) => s.authReady);
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const insets = useSafeAreaInsets();
  const launchTime = useRef(Date.now());

  useEffect(() => {
    if (authReady) {
      const elapsed = Date.now() - launchTime.current;
      const remaining = Math.max(0, 1000 - elapsed);
      const timer = setTimeout(() => {
        navigation.replace(loggedIn ? 'Folders' : 'Home');
      }, remaining);
      return () => clearTimeout(timer);
    }
  }, [authReady, loggedIn, navigation]);

  const statusBarHeight = Platform.OS === 'android' ? Math.max(insets.top, StatusBar.currentHeight ?? 0) : insets.top;

  const s = StyleSheet.create({
    container: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: t.colors.background,
      paddingTop: statusBarHeight,
    },
    iconWrap: {
      width: 80, height: 80, borderRadius: 20, backgroundColor: t.colors.primaryLight,
      alignItems: 'center', justifyContent: 'center',
      marginBottom: t.spacing.xl,
    },
    title: {
      fontSize: t.fontSize.xxl, fontWeight: 'bold',
      color: t.colors.text, textAlign: 'center',
    },
    subtitle: {
      fontSize: t.fontSize.sm, color: t.colors.textSub,
      textAlign: 'center', marginTop: t.spacing.sm,
    },
  });

  return (
    <View style={s.container}>
      <StatusBar barStyle={t.isDark ? 'light-content' : 'dark-content'} translucent backgroundColor="transparent" />
      <View style={s.iconWrap}>
        <Image source={require('../../resource/icon.png')} style={{ width: 100, height: 100 }} />
      </View>
      <Text style={s.title}>Nyami</Text>
      <Text style={s.subtitle}>猫在听，你也在听</Text>
    </View>
  );
};
