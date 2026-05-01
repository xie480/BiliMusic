import React from 'react';
import { View, Text } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { Button } from './Button';
import { useTheme } from '../theme';

interface Props { message: string; onRetry?: () => void; }

export const ErrorView: React.FC<Props> = ({ message, onRetry }) => {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 }}>
      <Icon name="alert-circle-outline" size={56} color={t.colors.error} />
      <Text style={{
        marginTop: t.spacing.lg,
        color: t.colors.textSub,
        fontSize: t.fontSize.base,
        textAlign: 'center',
      }}>{message}</Text>
      {onRetry && (
        <Button
          title="重试"
          variant="secondary"
          onPress={onRetry}
          style={{ marginTop: t.spacing.lg, paddingHorizontal: 32 }}
        />
      )}
    </View>
  );
};
