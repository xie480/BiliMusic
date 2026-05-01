export const lightColors = {
  primary: '#FB7299',
  primaryDark: '#E85A85',
  primaryLight: '#FFE4EC',

  background: '#FFFFFF',
  surface: '#F7F8FA',
  surfaceHigh: '#EEF0F3',

  text: '#18191C',
  textSub: '#61666D',
  textHint: '#9499A0',
  divider: '#E3E5E7',

  success: '#00C580',
  warning: '#F5A623',
  error: '#F23F3F',

  // 用于反色文字（如主色按钮上的文字）
  onPrimary: '#FFFFFF',
};

export const darkColors: typeof lightColors = {
  primary: '#FB7299',
  primaryDark: '#C95A78',
  primaryLight: '#2C1B22',

  background: '#0F0F11',
  surface: '#18191C',
  surfaceHigh: '#232529',

  text: '#F1F2F3',
  textSub: '#9499A0',
  textHint: '#61666D',
  divider: '#2C2E33',

  success: '#00C580',
  warning: '#F5A623',
  error: '#F23F3F',

  onPrimary: '#FFFFFF',
};

export type Colors = typeof lightColors;
