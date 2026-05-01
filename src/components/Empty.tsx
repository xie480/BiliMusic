import React from 'react';
import { View, Text } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme';

interface Props { icon?: string; title?: string; hint?: string; }

export const Empty: React.FC<Props> = ({
  icon = 'inbox-outline', title = '没有数据', hint,
}) => {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <Icon name={icon} size={64} color={t.colors.textHint} />
      <Text style={{
        marginTop: t.spacing.lg,
        color: t.colors.textSub,
        fontSize: t.fontSize.md,
      }}>{title}</Text>
      {hint && (
        <Text style={{
          marginTop: t.spacing.sm,
          color: t.colors.textHint,
          fontSize: t.fontSize.sm,
          textAlign: 'center',
        }}>{hint}</Text>
      )}
    </View>
  );
};
