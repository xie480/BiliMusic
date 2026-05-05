import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { IconButton } from './IconButton';
import { GlassView } from './GlassView';
import { useTheme } from '../theme';

/**
 * Header 组件现在接受 `left` 属性，用于在左侧放置自定义按钮。
 * 当提供 `left` 时会覆盖默认的返回按钮 (`showBack`).
 */
interface Props {
  title: string;
  /** 是否显示默认返回按钮（仅在未提供 left 时生效） */
  showBack?: boolean;
  /** 自定义左侧内容（如多选/取消按钮） */
  left?: React.ReactNode;
  /** 右侧额外内容 */
  right?: React.ReactNode;
  /** 是否移除底部边框/阴影 */
  noBorder?: boolean;
}

export const Header: React.FC<Props> = ({ title, showBack, left, right, noBorder }) => {
  const t = useTheme();
  const nav = useNavigation();
  const isGlass = !!t.glass;

  const s = StyleSheet.create({
    outer: {
      borderBottomWidth: (isGlass || noBorder) ? 0 : 0.5,
      borderBottomColor: t.colors.divider,
      elevation: 0,
      shadowOpacity: 0,
    },
    container: {
      height: 48, flexDirection: 'row', alignItems: 'center',
      paddingHorizontal: t.spacing.sm,
    },
    title: {
      flex: 1, fontSize: t.fontSize.lg, fontWeight: '600',
      color: t.colors.text, textAlign: 'center',
    },
    side: { width: 40, alignItems: 'center' },
  });

  const inner = (
    <View style={s.container}>
      {/* 左侧区域：优先渲染 left，自定义按钮；若未提供且 showBack 为 true，则渲染返回按钮 */}
      <View style={s.side}>
        {left ?? (showBack && (
          <IconButton name="chevron-left" size={28} onPress={() => nav.goBack()} />
        ))}
      </View>
      <Text style={s.title} numberOfLines={1}>{title}</Text>
      <View style={s.side}>{right}</View>
    </View>
  );

  const bgColor = t.isDark ? '#0F0F11' : '#FFFFFF';
  return <View style={[s.outer, { backgroundColor: bgColor }]}>{inner}</View>;
};
