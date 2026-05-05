import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Image,
  StyleSheet,
  Animated,
  Platform,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { BlurView } from '@react-native-community/blur';
import { useTheme } from '../theme';
import { useSettingsStore } from '../store/settingsStore';
import { useUIStore } from '../store/uiStore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const TRANSITION_DURATION = 50;

/**
 * Premium background engine with global custom background support.
 *
 * Architecture: dual-layer
 *   - Stable base layer: always rendered at full opacity, no animation.
 *     Contains the background image / gradient + blur, ensuring there is
 *     never a frame without background coverage during route transitions.
 *   - Enhanced overlay layer: animated masks (diffusion, readability, strong)
 *     that fade in/out to provide visual polish without affecting coverage.
 *
 * Transition coordination with ThemeProvider:
 *   - When isGlass becomes true, glassTransitionComplete is set immediately,
 *     so ThemeProvider switches background to transparent on the next frame.
 *   - When leaving glass mode, the enhanced overlay fades out, then
 *     glassTransitionComplete is set to false allowing baseColors.background back.
 */
export const GlassBackground: React.FC = () => {
  const { glass, isDark } = useTheme();
  const customBackgroundImage = useSettingsStore((s) => s.customBackgroundImage);
  const glassBlurAmount = useSettingsStore((s) => s.glassBlurAmount);
  const setGlassTransitionComplete = useUIStore((s) => s.setGlassTransitionComplete);
  const insets = useSafeAreaInsets();

  const isGlass = !!glass;

  // Anti-flicker mechanism: immediately clear active background state when not in glass mode
  // customBackgroundImage remains persisted in settingsStore
  const activeBg = isGlass ? customBackgroundImage : null;
  const hasCustomBg = !!activeBg;

  // ── Opacity animation for the enhanced overlay ────────────────────────
  const overlayAnim = useRef(new Animated.Value(isGlass ? 1 : 0)).current;

  useEffect(() => {
    const toValue = isGlass ? 1 : 0;
    // Immediately allow transparency when entering glass mode
    if (isGlass) {
      setGlassTransitionComplete(true);
    }
    Animated.timing(overlayAnim, {
      toValue,
      duration: isGlass ? TRANSITION_DURATION : 300,
      useNativeDriver: true,
    }).start(() => {
      if (!isGlass) {
        setGlassTransitionComplete(false);
      }
    });
  }, [isGlass, overlayAnim, setGlassTransitionComplete]);

  // ── Resolve blur radius ───────────────────────────────────────────
  const rawBlur = isGlass ? (glassBlurAmount ?? glass!.material.blurRadius) : 0;
  const effectiveBlur = Platform.OS === 'android' ? Math.min(rawBlur, 25) : rawBlur;

  // ── Mask colours ──────────────────────────────────────────────────
  const diffusionMask = isDark ? 'rgba(10, 10, 20, 0.45)' : 'rgba(240, 240, 248, 0.40)';
  const readabilityMask = isDark ? 'rgba(10, 10, 20, 0.32)' : 'rgba(255, 255, 255, 0.28)';
  const strongMask = isDark ? 'rgba(0, 0, 0, 0.55)' : 'rgba(255, 255, 255, 0.65)';

  // ── Stable base layer — always at full opacity, never animated ─────
  const stableBase = (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      {hasCustomBg ? (
        <Image
          source={{ uri: activeBg! }}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
          blurRadius={effectiveBlur}
        />
      ) : isGlass ? (
        <Image
          source={isDark ? require('../../resource/dark.jpg') : require('../../resource/light.jpg')}
          style={StyleSheet.absoluteFillObject}
          resizeMode="cover"
          blurRadius={effectiveBlur}
        />
      ) : null}
    </View>
  );

  // Non-glass plain background to fill the space when not in glass mode
  const nonGlassBase = !isGlass ? (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
      <LinearGradient
        colors={
          isDark
            ? ['#0F0F11', '#0F0F11']
            : ['#FFFFFF', '#FFFFFF']
        }
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      />
    </View>
  ) : null;

  // ── Enhanced overlay: masks that can animate ────────────────────────
  const enhancedOverlay = (
    <Animated.View
      style={[StyleSheet.absoluteFillObject, { opacity: overlayAnim }]}
      pointerEvents="none"
    >
      {hasCustomBg && isGlass && (
        <View
          style={[StyleSheet.absoluteFillObject, { backgroundColor: diffusionMask }]}
        />
      )}
      {isGlass && (
        <View
          style={[StyleSheet.absoluteFillObject, { backgroundColor: readabilityMask }]}
        />
      )}
    </Animated.View>
  );

  return (
    <View style={[StyleSheet.absoluteFillObject, { top: insets.top, bottom: insets.bottom }]} pointerEvents="none">
      {nonGlassBase}
      {stableBase}
      {enhancedOverlay}
    </View>
  );
};
