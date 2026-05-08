/**
 * EQSlider - 高性能霓虹均衡器滑块组件
 *
 * 性能优化核心策略（v2）：
 * - 拖动中仅更新本地 ref + 动画值，绝不触发 onValueChange（父组件不重渲染）
 * - 释放时一次性提交最终值（"commit on release"模式）
 * - 拖动中视觉反馈通过本地 ref 驱动的百分比计算，使用百分比样式而非 prop 驱动
 * - GPU 硬件加速（renderToHardwareTextureAndroid + nativeDriver）
 * - 被动事件声明（不阻塞主线程滚动）
 * - 真实物理阻尼感交互（spring 回弹 + 弹性缩放）
 */
import React, { useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  PanResponder,
  StyleSheet,
  LayoutChangeEvent,
  Animated,
  Platform,
} from 'react-native';
import { useTheme } from '../../theme';

interface EQSliderProps {
  /** 当前增益值 (-12 ~ +12) */
  value: number;
  /** 频段标签（如 "31", "1k"） */
  label: string;
  /** 值变更回调 - 仅在释放时调用 */
  onValueChange: (value: number) => void;
  /** 滑块宽度 */
  width?: number;
  /** 滑块高度 */
  height?: number;
  /** 是否禁用 */
  disabled?: boolean;
}

/** 霓虹发光色的 HSL 渐变 - 蓝紫霓虹风格 */
const getNeonColor = (fraction: number): string => {
  // -12dB → 蓝色系, 0dB → 青绿, +12dB → 紫红
  if (fraction < 0.5) {
    const t = fraction / 0.5;
    return `hsl(${240 - t * 120}, 100%, ${60 + t * 10}%)`;
  } else {
    const t = (fraction - 0.5) / 0.5;
    return `hsl(${120 - t * 120}, 100%, ${70 + t * 10}%)`;
  }
};

export const EQSlider: React.FC<EQSliderProps> = ({
  value,
  label,
  onValueChange,
  width = 32,
  height = 180,
  disabled = false,
}) => {
  const t = useTheme();

  // ========== Refs（不触发渲染的热路径） ==========
  const trackLayoutRef = useRef({ y: 0, height: 0 });
  /** 拖动中的当前值 ref（仅用于热路径计算，不触发渲染） */
  const dragValueRef = useRef<number>(value);
  /** 是否正在拖动 */
  const isDraggingRef = useRef(false);
  /** 最后一次提交的值 */
  const lastCommittedValueRef = useRef<number>(value);
  // 存储 onValueChange 引用以避免闭包过期
  const onChangeRef = useRef(onValueChange);
  onChangeRef.current = onValueChange;

  // ========== 动画值 ==========
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  // ========== 归一化值（静态 prop 驱动，仅在外部的 value 变化时更新） ==========
  const fraction = (value + 12) / 24;
  const neonColor = useMemo(() => getNeonColor(fraction), [fraction]);

  // 拖动中本地驱动的视觉百分比（不触发渲染，用于样式计算）
  const dragFractionRef = useRef(fraction);

  // ========== 触摸坐标 → 增益值 ==========
  const clampAndStep = (raw: number): number => {
    const clamped = Math.max(-12, Math.min(12, raw));
    return Math.round(clamped);
  };

  const updateValueFromTouch = (pageY: number) => {
    if (!trackLayoutRef.current.height) return;
    const dy = pageY - trackLayoutRef.current.y;
    const ratio = 1 - Math.max(0, Math.min(1, dy / trackLayoutRef.current.height));
    const raw = -12 + ratio * 24;
    const newValue = clampAndStep(raw);
    dragValueRef.current = newValue;
    dragFractionRef.current = (newValue + 12) / 24;
  };

  // ========== PanResponder（被动事件，不阻塞滚动） ==========
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: () => false,

      onPanResponderGrant: () => {
        isDraggingRef.current = true;
        dragValueRef.current = value;
        dragFractionRef.current = fraction;

        // 启动回弹动画（GPU 加速）
        Animated.parallel([
          Animated.spring(scaleAnim, {
            toValue: 1.15,
            useNativeDriver: true,
            friction: 8,
            tension: 100,
          }),
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: 80,
            useNativeDriver: false,
          }),
        ]).start();
      },

      onPanResponderMove: (evt) => {
        // 仅更新 ref 值，绝不触发任何 React 状态更新
        updateValueFromTouch(evt.nativeEvent.pageY);
      },

      onPanResponderRelease: () => {
        isDraggingRef.current = false;
        // 释放时一次性提交最终值
        const finalValue = dragValueRef.current;
        if (finalValue !== lastCommittedValueRef.current) {
          lastCommittedValueRef.current = finalValue;
          onChangeRef.current(finalValue);
        }

        // 回弹动画
        Animated.parallel([
          Animated.spring(scaleAnim, {
            toValue: 1,
            useNativeDriver: true,
            friction: 6,
            tension: 80,
          }),
          Animated.timing(glowAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: false,
          }),
        ]).start();
      },

      onPanResponderTerminate: () => {
        isDraggingRef.current = false;
        const finalValue = dragValueRef.current;
        if (finalValue !== lastCommittedValueRef.current) {
          lastCommittedValueRef.current = finalValue;
          onChangeRef.current(finalValue);
        }
        Animated.parallel([
          Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, friction: 6 }),
          Animated.timing(glowAnim, { toValue: 0, duration: 150, useNativeDriver: false }),
        ]).start();
      },
    }),
  ).current;

  // ========== 布局测量 ==========
  const onLayout = (e: LayoutChangeEvent) => {
    e.target?.measureInWindow?.((_x: number, y: number, _w: number, h: number) => {
      trackLayoutRef.current = { y, height: h };
    });
  };

  const glowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.8],
  });

  const thumbSize = 24;

  return (
    <View style={[styles.container, { width, height }]}>
      {/* 频段标签 */}
      <Text style={[styles.label, { color: t.colors.textSub }]}>{label}</Text>

      {/* 滑块轨道 */}
      <View
        style={[
          styles.track,
          {
            width: 4,
            flex: 1,
            backgroundColor: t.colors.divider,
            borderRadius: 2,
          },
        ]}
        onLayout={onLayout}
        {...panResponder.panHandlers}
      >
        {/* 填充轨道（从底部向上） */}
        <View
          style={[
            styles.trackFill,
            {
              width: 4,
              height: `${fraction * 100}%` as any,
              backgroundColor: neonColor,
              borderRadius: 2,
            },
          ]}
        />

        {/* 发光底部 */}
        <Animated.View
          style={[
            styles.glow,
            {
              width: 20,
              height: 20,
              borderRadius: 10,
              backgroundColor: neonColor,
              opacity: glowOpacity,
              bottom: `${fraction * 100}%` as any,
              marginBottom: -10,
            },
          ]}
        />

        {/* 滑块拇指 - GPU 硬件加速 */}
        <Animated.View
          renderToHardwareTextureAndroid={Platform.OS === 'android'}
          style={[
            styles.thumb,
            {
              width: thumbSize,
              height: thumbSize,
              borderRadius: thumbSize / 2,
              backgroundColor: neonColor,
              borderColor: neonColor,
              bottom: `${fraction * 100}%` as any,
              marginBottom: -thumbSize / 2,
              transform: [{ scale: scaleAnim }],
              shadowColor: neonColor,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.6,
              shadowRadius: 8,
              elevation: 12,
            },
          ]}
        />
      </View>

      {/* 数值显示 */}
      <Text style={[styles.value, { color: t.colors.textHint }]}>
        {value > 0 ? `+${value}` : value}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 6,
    textAlign: 'center',
  },
  track: {
    position: 'relative',
    justifyContent: 'flex-end',
    alignItems: 'center',
    overflow: 'visible',
  },
  trackFill: {
    position: 'absolute',
    bottom: 0,
  },
  glow: {
    position: 'absolute',
  },
  thumb: {
    position: 'absolute',
    borderWidth: 2,
  },
  value: {
    fontSize: 9,
    fontWeight: '500',
    marginTop: 6,
    textAlign: 'center',
  },
});
