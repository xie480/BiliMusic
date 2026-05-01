import React from 'react';
import {
  TouchableOpacity, Text, StyleSheet, ActivityIndicator,
  ViewStyle, StyleProp,
} from 'react-native';
import { useTheme } from '../theme';

interface Props {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'text';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export const Button: React.FC<Props> = ({
  title, onPress, variant = 'primary', disabled, loading, style,
}) => {
  const t = useTheme();

  const styles = StyleSheet.create({
    base: {
      height: 48,
      borderRadius: t.radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: t.spacing.lg,
    },
    primary: { backgroundColor: t.colors.primary },
    secondary: {
      backgroundColor: t.colors.surface,
      borderWidth: 1,
      borderColor: t.colors.divider,
    },
    text: { backgroundColor: 'transparent', height: 'auto', paddingVertical: t.spacing.sm },
    titlePrimary: { color: t.colors.onPrimary, fontSize: t.fontSize.md, fontWeight: '600' },
    titleSecondary: { color: t.colors.text, fontSize: t.fontSize.md, fontWeight: '500' },
    titleText: { color: t.colors.primary, fontSize: t.fontSize.base },
    disabled: { opacity: 0.4 },
  });

  const containerStyle = [
    styles.base,
    styles[variant],
    disabled && styles.disabled,
    style,
  ];
  const titleStyle = [
    variant === 'primary' && styles.titlePrimary,
    variant === 'secondary' && styles.titleSecondary,
    variant === 'text' && styles.titleText,
  ];

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      disabled={disabled || loading}
      style={containerStyle}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? '#fff' : t.colors.primary} />
      ) : (
        <Text style={titleStyle}>{title}</Text>
      )}
    </TouchableOpacity>
  );
};
