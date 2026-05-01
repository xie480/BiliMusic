import React from 'react';
import { Switch as RNSwitch } from 'react-native';
import { useTheme } from '../theme';

interface Props { value: boolean; onValueChange: (v: boolean) => void; }

export const Switch: React.FC<Props> = ({ value, onValueChange }) => {
  const t = useTheme();
  return (
    <RNSwitch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: t.colors.divider, true: t.colors.primary }}
      thumbColor="#fff"
    />
  );
};
