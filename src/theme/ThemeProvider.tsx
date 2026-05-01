import React, { createContext, useContext, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, Colors } from './colors';
import { fontSize, fontWeight } from './typography';
import { spacing, radius } from './spacing';

export interface Theme {
  colors: Colors;
  isDark: boolean;
  fontSize: typeof fontSize;
  fontWeight: typeof fontWeight;
  spacing: typeof spacing;
  radius: typeof radius;
}

const ThemeContext = createContext<Theme | null>(null);

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const value: Theme = {
    colors: isDark ? darkColors : lightColors,
    isDark,
    fontSize,
    fontWeight,
    spacing,
    radius,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeProvider missing');
  return ctx;
}
