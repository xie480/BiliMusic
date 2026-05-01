import React from 'react';
import { View, ActivityIndicator, Text } from 'react-native';
import { useTheme } from '../theme';

export const Loading: React.FC<{ text?: string }> = ({ text = '加载中...' }) => {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={t.colors.primary} />
      <Text style={{ marginTop: t.spacing.md, color: t.colors.textSub, fontSize: t.fontSize.sm }}>
        {text}
      </Text>
    </View>
  );
};
