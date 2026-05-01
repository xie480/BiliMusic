import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useTheme } from '../theme';

interface Props {
  title: string;
  subtitle?: string;
  icon?: string;
  iconBg?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  showArrow?: boolean;
}

export const ListItem: React.FC<Props> = ({
  title, subtitle, icon, iconBg, right, onPress, showArrow,
}) => {
  const t = useTheme();
  const Container: any = onPress ? TouchableOpacity : View;

  const s = StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: t.spacing.md,
      paddingHorizontal: t.spacing.lg,
      backgroundColor: t.colors.surface,
    },
    iconBox: {
      width: 40, height: 40, borderRadius: t.radius.md,
      alignItems: 'center', justifyContent: 'center',
      marginRight: t.spacing.md,
      backgroundColor: iconBg || t.colors.primaryLight,
    },
    content: { flex: 1 },
    title: { fontSize: t.fontSize.md, color: t.colors.text, fontWeight: '500' },
    subtitle: { fontSize: t.fontSize.sm, color: t.colors.textSub, marginTop: 2 },
    right: { marginLeft: t.spacing.sm },
  });

  return (
    <Container activeOpacity={0.7} onPress={onPress} style={s.container}>
      {icon && (
        <View style={s.iconBox}>
          <Icon name={icon} size={22} color={t.colors.primary} />
        </View>
      )}
      <View style={s.content}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        {subtitle && <Text style={s.subtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>
      {right ? <View style={s.right}>{right}</View> : null}
      {showArrow && (
        <Icon name="chevron-right" size={22} color={t.colors.textHint} />
      )}
    </Container>
  );
};
