import React, { useState } from 'react';
import { View, PanResponder, StyleSheet, LayoutChangeEvent } from 'react-native';
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

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      setSeeking(true);
      onSeekStart?.();
      const x = e.nativeEvent.locationX;
      setLocalProgress(Math.max(0, Math.min(1, x / width)));
    },
    onPanResponderMove: (e, gs) => {
      const x = Math.max(0, Math.min(width, e.nativeEvent.locationX));
      setLocalProgress(x / width);
    },
    onPanResponderRelease: () => {
      setSeeking(false);
      onSeekEnd?.(localProgress);
    },
  });

  const s = StyleSheet.create({
    container: { paddingVertical: 10 },
    bar: {
      height: 3, backgroundColor: t.colors.divider, borderRadius: 2,
      overflow: 'visible',
    },
    fill: {
      height: '100%', backgroundColor: t.colors.primary, borderRadius: 2,
    },
    thumb: {
      position: 'absolute', top: -5, width: 13, height: 13,
      borderRadius: 7, backgroundColor: t.colors.primary,
    },
  });

  return (
    <View {...responder.panHandlers}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          style={s.container}>
      <View style={s.bar}>
        <View style={[s.fill, { width: `${p * 100}%` }]} />
        {seeking && (
          <View style={[s.thumb, { left: `${p * 100}%`, marginLeft: -6.5 }]} />
        )}
      </View>
    </View>
  );
};
