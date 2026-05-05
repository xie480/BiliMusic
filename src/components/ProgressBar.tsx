import React, { useState, useCallback } from 'react';
import { View, PanResponder, StyleSheet, LayoutChangeEvent } from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useTheme } from '../theme';

interface Props {
  progress: number;        // 0~1
  onSeekStart?: () => void;
  onSeekEnd?: (p: number) => void;
}

export const ProgressBar: React.FC<Props> = ({ progress, onSeekStart, onSeekEnd }) => {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [localProgress, setLocalProgress] = useState(0);

  const p = seeking ? localProgress : progress;

  // Clamp progress between 0 and 1 in case of numeric errors
  const clamp = useCallback((v: number) => Math.max(0, Math.min(1, v)), []);

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      if (width === 0) return; // layout not measured yet
      setSeeking(true);
      onSeekStart?.();
      const x = Math.min(width, Math.max(0, e.nativeEvent.locationX));
      setLocalProgress(clamp(x / width));
    },
    onPanResponderMove: (e) => {
      if (width === 0) return;
      const x = Math.min(width, Math.max(0, e.nativeEvent.locationX));
      setLocalProgress(clamp(x / width));
    },
    onPanResponderRelease: () => {
      setSeeking(false);
      onSeekEnd?.(clamp(localProgress));
    },
    onPanResponderTerminationRequest: () => false,
  });

  const s = StyleSheet.create({
    container: { paddingVertical: 10 },
    bar: {
      height: 3,
      backgroundColor: t.colors.divider,
      borderRadius: 2,
      overflow: 'visible',
    },
    fill: {
      height: '100%',
      backgroundColor: t.colors.primary,
      borderRadius: 2,
    },
    thumb: {
      position: 'absolute',
      top: -5,
      width: 13,
      height: 13,
      borderRadius: 7,
      backgroundColor: t.colors.primary,
    },
  });

  return (
    <View
      {...responder.panHandlers}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={s.container}
    >
      <View style={s.bar}>
        {t.glass && t.glass.colors.progress.fill ? (
          <LinearGradient
            colors={t.glass.colors.progress.fill}
            start={{x:0,y:0}} end={{x:1,y:0}}
            style={[s.fill, { width: `${p * 100}%` }]}
          />
        ) : (
          <View style={[s.fill, { width: `${p * 100}%` }]} />
        )}
        {seeking && (
          <View style={[s.thumb, { left: `${p * 100}%`, marginLeft: -6.5 }]} />
        )}
      </View>
    </View>
  );
};
