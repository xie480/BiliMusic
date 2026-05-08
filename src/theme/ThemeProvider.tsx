import React, { createContext, useContext, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, Colors } from './colors';
import { fontSize, fontWeight } from './typography';
import { spacing, radius } from './spacing';
import { useSettingsStore } from '../store/settingsStore';
import { GlassTheme, GlassLightTheme, GlassDarkTheme } from './glassTheme';

export interface Theme {
  colors: Colors;
  isDark: boolean;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  spacing: typeof spacing;
  radius: typeof radius;
  glass?: GlassTheme;
}

const ThemeContext = createContext<Theme | null>(null);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const systemScheme = useColorScheme();
  const themeMode = useSettingsStore((s) => s.themeMode);

  const isGlassLight = themeMode === 'glass-light';
  const isGlassDark = themeMode === 'glass-dark';
  const isGlass = isGlassLight || isGlassDark;

  const resolvedDark = themeMode === 'system'
    ? systemScheme === 'dark'
    : themeMode === 'dark' || themeMode === 'glass-dark';

  const isDark = resolvedDark;

  // 在玻璃模式下构建特殊的色彩方案：
  // - background 设为透明，让底层 GlassBackground 组件的光球和渐变透出
  // - surface 使用玻璃的半透明背景色，使卡片/面板呈现毛玻璃质感
  // - surfaceHigh 保持可见但降低透明度，用于搜索栏等次级元素
  // - 保留 primary / text / onPrimary / divider 等关键色值
  //
  // GlassBackground 现在采用稳定基底层，始终全屏覆盖，因此 ThemeProvider
  // 可以立即将 background 设为 transparent，不再需要等待过渡动画完成。
  const glassColors = isGlassLight ? GlassLightTheme.colors : GlassDarkTheme.colors;
  const baseColors = isDark ? darkColors : lightColors;

  const effectiveBackground = isGlass ? 'transparent' : baseColors.background;

  const value: Theme = {
    colors: isGlass
      ? {
          ...baseColors,
          background: effectiveBackground,
          // surface 使用玻璃半透明背景
          surface: glassColors.glass.bg,
          // surfaceHigh 用于搜索栏等，使用稍不透明的玻璃色
          surfaceHigh: isGlassLight ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.10)',
          // 主色调使用玻璃主题的强调色
          primary: glassColors.accent.primary,
          onPrimary: isGlassLight ? '#ffffff' : '#0a0a14',
          // 文字色彩使用玻璃主题定义
          text: glassColors.text.primary,
          textSub: glassColors.text.secondary,
          textHint: glassColors.text.tertiary,
          // 分隔线适应玻璃环境
          divider: isGlassLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)',
          // 错误色保留原主题
          error: baseColors.error,
          success: baseColors.success,
          warning: baseColors.warning,
          primaryDark: baseColors.primaryDark,
          primaryLight: isGlassLight ? 'rgba(108,92,231,0.12)' : 'rgba(180,77,255,0.12)',
        }
      : (isDark ? darkColors : lightColors),
    isDark,
    fontSize,
    fontWeight,
    spacing,
    radius,
    glass: isGlass
      ? (isGlassLight ? GlassLightTheme : GlassDarkTheme)
      : undefined,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeProvider missing');
  return ctx;
}
