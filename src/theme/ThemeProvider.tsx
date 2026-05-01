import React, { FC, ReactNode } from 'react';

/**
 * Minimal ThemeProvider placeholder to satisfy import in App.tsx.
 * It simply renders its children.
 */
export const ThemeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  return <>{children}</>;
};
