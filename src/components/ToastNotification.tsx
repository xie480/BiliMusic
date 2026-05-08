/**
 * ToastNotification - 全局顶部通知组件
 *
 * 用于展示 warn（黄色）和 error（红色）级别的日志通知
 * 调用方式：ToastNotification.show({ type: 'warn' | 'error', message: '...' })
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

export interface ToastConfig {
  type: 'warn' | 'error';
  message: string;
  duration?: number; // 显示时长，默认 4000ms
}

export interface ToastNotificationRef {
  show: (config: ToastConfig) => void;
}

const ToastNotification = forwardRef<ToastNotificationRef>((_props, ref) => {
  const [visible, setVisible] = useState(false);
  const [config, setConfig] = useState<ToastConfig | null>(null);
  const translateY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 清除定时器
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 显示通知
  const show = useCallback(
    (newConfig: ToastConfig) => {
      clearTimer();
      setConfig(newConfig);
      setVisible(true);

      // 滑入动画
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();

      // 自动隐藏
      const duration = newConfig.duration || 4000;
      timerRef.current = setTimeout(() => {
        hide();
      }, duration);
    },
    [translateY, opacity, clearTimer],
  );

  // 隐藏通知
  const hide = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -120,
        duration: 250,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setVisible(false);
      setConfig(null);
    });
  }, [translateY, opacity, clearTimer]);

  // 暴露 show 方法给父组件
  useImperativeHandle(ref, () => ({ show }), [show]);

  // 组件卸载时清理
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  if (!visible || !config) return null;

  const isError = config.type === 'error';

  return (
    <Animated.View
      style={[
        styles.container,
        isError ? styles.errorContainer : styles.warnContainer,
        { transform: [{ translateY }], opacity },
      ]}
    >
      <TouchableOpacity
        style={styles.content}
        onPress={hide}
        activeOpacity={0.8}
      >
        <View
          style={[
            styles.indicator,
            isError ? styles.errorIndicator : styles.warnIndicator,
          ]}
        />
        <View style={styles.textContainer}>
          <Text style={[styles.title, isError ? styles.errorTitle : styles.warnTitle]}>
            {isError ? '发生错误' : '警告'}
          </Text>
          <Text
            style={[styles.message, isError ? styles.errorMessage : styles.warnMessage]}
            numberOfLines={3}
            ellipsizeMode="tail"
          >
            {config.message}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
});

ToastNotification.displayName = 'ToastNotification';

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    elevation: 9999,
    paddingTop: 50, // 避开状态栏
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  warnContainer: {
    backgroundColor: '#FFF9C4',
    borderBottomWidth: 1,
    borderBottomColor: '#FFE082',
  },
  errorContainer: {
    backgroundColor: '#FFEBEE',
    borderBottomWidth: 1,
    borderBottomColor: '#EF9A9A',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  indicator: {
    width: 4,
    height: '100%',
    borderRadius: 2,
    marginRight: 10,
    marginTop: 2,
    minHeight: 30,
  },
  warnIndicator: {
    backgroundColor: '#FFC107',
  },
  errorIndicator: {
    backgroundColor: '#F44336',
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 2,
  },
  warnTitle: {
    color: '#F57F17',
  },
  errorTitle: {
    color: '#D32F2F',
  },
  message: {
    fontSize: 12,
    lineHeight: 17,
  },
  warnMessage: {
    color: '#795548',
  },
  errorMessage: {
    color: '#C62828',
  },
});

export default ToastNotification;
