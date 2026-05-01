import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { IconButton } from './IconButton';
import { useTheme } from '../theme';

interface Props {
  title: string;
  showBack?: boolean;
  right?: React.ReactNode;
}

export const Header: React.FC<Props> = ({ title, showBack, right }) => {
  const t = useTheme();
  const nav = useNavigation();

  const s = StyleSheet.create({
    container: {
      height: 48, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: t.spacing.sm,
      backgroundColor: t.colors.background,
      borderBottomWidth: 0.5,
      borderBottomColor: t.colors.divider,
    },
    title: {
      flex: 1, fontSize: t.fontSize.lg, fontWeight: '600',
      color: t.colors.text, textAlign: 'center',
    },
    side: { width: 40, alignItems: 'center' },
  });

  return (
    <View style={s.container}>
      <View style={s.side}>
        {showBack && (
          <IconButton name="chevron-left" size={28} onPress={() => nav.goBack()} />
        )}
      </View>
      <Text style={s.title} numberOfLines={1}>{title}</Text>
      <View style={s.side}>{right}</View>
    </View>
  );
};
