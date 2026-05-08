import React, { useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../../theme';
import { useEQStore, BAND_FREQUENCIES } from '../../store/eqStore';
import { EQSlider } from './EQSlider';

const styles = StyleSheet.create({
  container: {
    position: 'relative' as const,
    paddingRight: 4,
  },
  scaleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 4,
    paddingRight: 4,
    marginBottom: 4,
    height: 16,
  },
  scaleLabel: {
    fontSize: 8,
    fontWeight: '500',
    width: 20,
    textAlign: 'center',
  },
  scaleLine: {
    flex: 1,
    height: 1,
  },
  sliderRow: {
    alignItems: 'flex-end',
    gap: 4,
    paddingLeft: 4,
    paddingRight: 4,
  },
  sliderItem: {
    alignItems: 'center',
  },
  freqRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingLeft: 8,
    paddingRight: 8,
    marginTop: 4,
  },
  freqLabel: {
    fontSize: 8,
    fontWeight: '400',
    width: 32,
    textAlign: 'center',
  },
});

/**
 * GraphicEQ - 图形均衡器
 *
 * 性能优化：
 * - React.memo 包装避免父组件重渲染时重建整个 EQ 区域
 * - setGraphicBand 回调使用 useCallback + 稳定的 store selector
 * - 仅订阅必要的 store slice（graphicBands, enabled）
 */
export const GraphicEQ: React.FC = React.memo(() => {
  const t = useTheme();
  const graphicBands = useEQStore(s => s.graphicBands);
  const setGraphicBand = useEQStore(s => s.setGraphicBand);
  const enabled = useEQStore(s => s.enabled);

  // 稳定的回调：setGraphicBand 本身来自 zustand，引用稳定
  const handleValueChange = useCallback(
    (index: number, val: number) => setGraphicBand(index, val),
    [setGraphicBand],
  );

  return (
    <View style={styles.container}>
      {/* dB 标尺指示 */}
      <View style={styles.scaleRow}>
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>+12</Text>
        <View style={[styles.scaleLine, { backgroundColor: t.colors.divider }]} />
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>0</Text>
        <View style={[styles.scaleLine, { backgroundColor: t.colors.divider }]} />
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>-12</Text>
      </View>

      {/* 10 个频段的滑块 */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.sliderRow}
      >
        {BAND_FREQUENCIES.map((freq, index) => (
          <View key={freq} style={styles.sliderItem}>
            <EQSlider
              label={freq}
              value={graphicBands[index]}
              onValueChange={(val) => handleValueChange(index, val)}
              disabled={!enabled}
              width={36}
              height={170}
            />
          </View>
        ))}
      </ScrollView>

      {/* 频率标签 */}
      <View style={styles.freqRow}>
        {BAND_FREQUENCIES.map(freq => (
          <Text key={freq} style={[styles.freqLabel, { color: t.colors.textHint }]}>
            {freq}
          </Text>
        ))}
      </View>
    </View>
  );
});
