import React, { useState, useEffect } from 'react';
import { View, StyleSheet, ViewStyle, Platform, InteractionManager } from 'react-native';
import { BlurView } from '@react-native-community/blur';
import { useTheme } from '../theme';
import { useSettingsStore } from '../store/settingsStore';

interface GlassViewProps {
  children: React.ReactNode;
  style?: ViewStyle;
  blurRadius?: number;
  borderRadius?: number;
  /** Override background color (defaults to theme glass bg) */
  backgroundColor?: string;
  borderColor?: string;
  /** If true, renders without shadow (for flat headers etc) */
  noShadow?: boolean;
  /** If true, renders without blur (fallback for Android issues) */
  noBlur?: boolean;
}

/**
 * Ultra-premium dark frosted glass container — "极致暗黑磨砂玻璃".
 *
 * Features:
 *  - Extreme backdrop blur (64 px default) for deep frosted translucency
 *  - Multi-layered edge treatment:
 *      • Chromatic aberration fringing (subtle cyan/magenta shifts)
 *      • Inner highlight — simulates light catching the top-left glass edge
 *      • Shimmer edge wrap — ultra-soft luminous rim on right/bottom
 *  - Micro-grain noise overlay — physical sandblasted texture simulation
 *  - Ambient occlusion rim at the bottom for grounded depth
 *
 * All layers are pointerEvents="none" so they never interfere with
 * touch interactions on children.
 */
export const GlassView: React.FC<GlassViewProps> = ({
  children,
  style,
  blurRadius,
  borderRadius,
  backgroundColor: bgOverride,
  borderColor: borderOverride,
  noShadow = false,
  noBlur = false,
}) => {
  const t = useTheme();
  const glassTheme = t.glass;
  const globalBlurAmount = useSettingsStore((s) => s.glassBlurAmount);

  const resolvedBlurRadius = blurRadius ?? globalBlurAmount ?? glassTheme?.material.blurRadius ?? 32;
  const resolvedBorderRadius = borderRadius ?? t.radius.md;
  const glassColors = glassTheme?.colors.glass;
  const resolvedBg = bgOverride ?? glassColors?.bg ?? 'rgba(18,18,24,0.48)';
  const resolvedBorder = borderOverride ?? glassColors?.border ?? 'rgba(255,255,255,0.06)';
  const innerHighlight = glassColors?.highlightInner ?? 'rgba(255,255,255,0.14)';
  const shimmerEdge = glassColors?.shimmerEdge ?? 'rgba(255,255,255,0.18)';

  const blurType = t.isDark ? ('dark' as const) : ('light' as const);

  const [isAnimating, setIsAnimating] = useState(true);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setIsAnimating(false);
    });
    return () => task.cancel();
  }, []);

  // ── Outer container: holds shadows + clips inner content ──────────
  const outerStyle: ViewStyle = {
    borderRadius: resolvedBorderRadius,
    ...(noShadow
      ? {}
      : Platform.select({
          ios: {
            shadowColor: 'rgba(0,0,0,0.85)',
            shadowOffset: { width: 0, height: 18 },
            shadowOpacity: 1,
            shadowRadius: 56,
          },
          android: {
            elevation: 24,
          },
        })),
  };

  return (
    // 【性能优化】collapsable=false 防止 Android 上 View 融合优化（Overdraw 优化），
    // 确保 BlurView 的 backdrop 模糊层始终正确渲染
    <View style={[outerStyle, style]} {...(Platform.OS === 'android' ? { collapsable: false as any } : {})}>
      {/* Inner clip region — overflow hidden lives here so outer shadow isn't clipped */}
      <View style={{ overflow: 'hidden', borderRadius: resolvedBorderRadius }}>
        {/* ── Backdrop blur layer ─────────────────────────────────── */}
        {!noBlur && !isAnimating && (
          <BlurView
            style={StyleSheet.absoluteFill}
            blurType={blurType}
            blurAmount={resolvedBlurRadius}
            reducedTransparencyFallbackColor={resolvedBg}
          />
        )}

        {/* ── Glass base ──────────────────────────────────────────── */}
        <View
          style={{
            backgroundColor: resolvedBg,
            borderRadius: resolvedBorderRadius,
          }}
        >
          {/* ── 1. Chromatic aberration fringing ─────────────────────
               Ultra-thin colour shift at edges; cyan on top, magenta on
               bottom — simulates light dispersion through glass. ─── */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: resolvedBorderRadius,
                borderWidth: 1.5,
                borderColor: resolvedBorder,
                borderTopColor: 'rgba(0, 229, 255, 0.07)',
                borderBottomColor: 'rgba(180, 77, 255, 0.05)',
              },
            ]}
            pointerEvents="none"
          />

          {/* ── 2. Inner highlight (top-left light catch) ──────────── */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: resolvedBorderRadius,
                borderWidth: 1,
                borderColor: 'transparent',
                borderTopColor: innerHighlight,
                borderLeftColor: 'rgba(255,255,255,0.07)',
                margin: 1,
              },
            ]}
            pointerEvents="none"
          />

          {/* ── 3. Shimmer edge wrap (right + bottom) ──────────────── */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: resolvedBorderRadius,
                borderWidth: 2,
                borderColor: 'transparent',
                borderRightColor: shimmerEdge,
                borderBottomColor: 'rgba(255,255,255,0.04)',
                margin: -1,
                opacity: 0.5,
              },
            ]}
            pointerEvents="none"
          />

          {/* ── 4. Micro-grain noise overlay ─────────────────────────
               Simulates physical sandblasted / frosted grain texture
               via a subtle flat tint with very low opacity. ──────── */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: resolvedBorderRadius,
                backgroundColor: 'rgba(255, 255, 255, 0.016)',
              },
            ]}
            pointerEvents="none"
          />

          {/* ── 5. Ambient occlusion rim (bottom shadow accent) ────── */}
          <View
            style={[
              StyleSheet.absoluteFill,
              {
                borderRadius: resolvedBorderRadius,
                borderBottomWidth: 2,
                borderBottomColor: 'rgba(0, 0, 0, 0.35)',
              },
            ]}
            pointerEvents="none"
          />

          {/* ── Content ───────────────────────────────────────────── */}
          <View>{children}</View>
        </View>
      </View>
    </View>
  );
};
