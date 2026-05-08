/**
 * ParametricEQ - PEQ 参数均衡器交互曲线组件
 *
 * 功能：
 * - 显示频率响应曲线（x 轴：对数频率 20Hz~20kHz，y 轴：-12~+12dB）
 * - 可拖动节点：纵向拖动调整增益，横向拖动调整频率
 * - 点击节点打开编辑器
 * - 多滤波器叠加显示总响应曲线
 *
 * 性能优化（v2）：
 * - DraggableNode 拖动中仅更新本地 ref 位置，不触发任何 React 状态更新
 * - 释放时一次性提交最终频率和增益值
 * - curvePoints 使用 useMemo 在 filters 变化时重新计算
 */
import React, { useRef, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  PanResponder,
  LayoutChangeEvent,
} from 'react-native';
import { useTheme } from '../../theme';
import { useEQStore, PEQFilter, FilterType } from '../../store/eqStore';

/** 曲线绘图区域尺寸（基线，运行时动态计算宽度） */
const GRAPH_HEIGHT = 180;
const GRAPH_PAD = { top: 16, bottom: 16, left: 32, right: 28 };

/** 频率范围（对数刻度） */
const FREQ_MIN = 20;
const FREQ_MAX = 20000;
const GAIN_MIN = -12;
const GAIN_MAX = 12;

/** 滤波器颜色映射 */
const FILTER_COLORS: Record<FilterType, string> = {
  Peak: '#00D2FF',
  LowShelf: '#6C5CE7',
  HighShelf: '#FD79A8',
  LowPass: '#00B894',
  HighPass: '#E17055',
  Notch: '#FDCB6E',
  BandPass: '#00CEC9',
};

/**
 * 创建基于当前容器宽度的坐标转换函数
 */
const makeFreqToX = (width: number) => (freq: number): number => {
  const logMin = Math.log10(FREQ_MIN);
  const logMax = Math.log10(FREQ_MAX);
  const logFreq = Math.log10(Math.max(FREQ_MIN, Math.min(FREQ_MAX, freq)));
  const fraction = (logFreq - logMin) / (logMax - logMin);
  return GRAPH_PAD.left + fraction * (width - GRAPH_PAD.left - GRAPH_PAD.right);
};

const makeXToFreq = (width: number) => (x: number): number => {
  const logMin = Math.log10(FREQ_MIN);
  const logMax = Math.log10(FREQ_MAX);
  const availWidth = width - GRAPH_PAD.left - GRAPH_PAD.right;
  const fraction = (x - GRAPH_PAD.left) / availWidth;
  const logFreq = logMin + fraction * (logMax - logMin);
  return Math.round(Math.pow(10, logFreq));
};

/**
 * 创建基于当前容器高度的坐标转换函数
 */
const makeGainToY = (height: number) => (gain: number): number => {
  const fraction = (gain - GAIN_MIN) / (GAIN_MAX - GAIN_MIN);
  return GRAPH_PAD.top + (1 - fraction) * (height - GRAPH_PAD.top - GRAPH_PAD.bottom);
};

const makeYToGain = (height: number) => (y: number): number => {
  const availHeight = height - GRAPH_PAD.top - GRAPH_PAD.bottom;
  const fraction = 1 - (y - GRAPH_PAD.top) / availHeight;
  return Math.round((GAIN_MIN + fraction * (GAIN_MAX - GAIN_MIN)) * 2) / 2;
};

// ========== Props ==========

interface ParametricEQProps {
  filters: PEQFilter[];
  onSelectFilter: (id: number) => void;
  selectedFilterId: number | null;
}

// ========== Component ==========

export const ParametricEQ: React.FC<ParametricEQProps> = ({
  filters,
  onSelectFilter,
  selectedFilterId,
}) => {
  const t = useTheme();
  const updatePEQFilter = useEQStore(s => s.updatePEQFilter);

  // 动态计算容器宽度（基于窗口宽度）
  // 使用 ref 存储以避免对 useWindowDimensions 的依赖
  const graphWidthRef = useRef(300);
  // 初始值，将在 onLayout 中更新
  const graphWidth = graphWidthRef.current;
  const plotWidth = graphWidth - GRAPH_PAD.left - GRAPH_PAD.right;

  // 坐标转换函数（基于动态宽高）
  const freqToX = useMemo(() => makeFreqToX(graphWidth), [graphWidth]);
  const xToFreq = useMemo(() => makeXToFreq(graphWidth), [graphWidth]);
  const gainToY = useMemo(() => makeGainToY(GRAPH_HEIGHT), []);
  const yToGain = useMemo(() => makeYToGain(GRAPH_HEIGHT), []);

  /** 计算该频点下所有滤波器的复合增益 */
  const computeCombinedResponse = useCallback(
    (freq: number): number => {
      let totalGain = 0;
      for (const filter of filters) {
        if (!filter.enabled) continue;
        totalGain += filterResponseAt(filter, freq);
      }
      return Math.max(GAIN_MIN, Math.min(GAIN_MAX, totalGain));
    },
    [filters],
  );

  /** 预计算曲线点（100 个采样点） */
  const curvePoints = useMemo(() => {
    const points: Array<{ freq: number; x: number; y: number; gain: number }> = [];
    const SAMPLE_COUNT = 100;
    const logMin = Math.log10(FREQ_MIN);
    const logMax = Math.log10(FREQ_MAX);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const freq = Math.pow(10, logMin + (i / (SAMPLE_COUNT - 1)) * (logMax - logMin));
      const gain = computeCombinedResponse(freq);
      points.push({
        freq: Math.round(freq),
        x: freqToX(freq),
        y: gainToY(gain),
        gain,
      });
    }
    return points;
  }, [computeCombinedResponse, freqToX, gainToY]);

  const onGraphLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) graphWidthRef.current = w;
  }, []);

  return (
    <View style={styles.container} onLayout={onGraphLayout}>
      {/* dB 刻度标签（左侧） */}
      <View style={styles.scaleLabels} pointerEvents="none">
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>+12</Text>
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>0</Text>
        <Text style={[styles.scaleLabel, { color: t.colors.textHint }]}>-12</Text>
      </View>

      {/* 曲线绘图区域 */}
      <View
        style={[
          styles.graphArea,
          {
            width: graphWidth,
            height: GRAPH_HEIGHT,
            backgroundColor: 'rgba(0,0,0,0.15)',
            borderRadius: 8,
            overflow: 'visible',
          },
        ]}
      >
        {/* 网格线 */}
        {[-6, 0, 6].map(dB => (
          <View
            key={`grid-${dB}`}
            style={[
              styles.gridLine,
              {
                top: gainToY(dB),
                backgroundColor: t.colors.divider,
              },
            ]}
          />
        ))}

        {/* 中轴线 (0dB) */}
        <View
          style={[
            styles.centerLine,
            {
              top: gainToY(0),
              backgroundColor: t.colors.primary + '40',
            },
          ]}
        />

        {/* 响应曲线 */}
        <View style={styles.curveContainer}>
          {curvePoints.map((pt, i) => {
            if (i === 0) return null;
            const prev = curvePoints[i - 1];
            return (
              <View
                key={`curve-${i}`}
                style={[
                  styles.curveSegment,
                  {
                    left: prev.x,
                    top: Math.min(prev.y, pt.y),
                    width: Math.max(1, pt.x - prev.x),
                    height: Math.abs(pt.y - prev.y) + 1,
                    backgroundColor: t.colors.primary,
                    opacity: 0.7,
                  },
                ]}
              />
            );
          })}
        </View>

        {/* 空状态提示 */}
        {filters.filter(f => f.enabled).length === 0 && (
          <View style={styles.emptyHint}>
            <Text style={[styles.emptyText, { color: t.colors.textHint }]}>
              启用滤波器以显示曲线
            </Text>
          </View>
        )}

        {/* 滤波器拖动节点 */}
        {filters
          .filter(f => f.enabled)
          .map(filter => (
            <DraggableNode
              key={filter.id}
              filter={filter}
              color={FILTER_COLORS[filter.type] ?? t.colors.primary}
              isSelected={selectedFilterId === filter.id}
              onCommit={(freq, gain) => {
                updatePEQFilter(filter.id, { frequency: freq, gain });
              }}
              onPress={() => onSelectFilter(filter.id)}
              freqToX={freqToX}
              xToFreq={xToFreq}
              gainToY={gainToY}
              yToGain={yToGain}
            />
          ))}
      </View>

      {/* 频率刻度标签 */}
      <View style={[styles.freqLabels, { marginLeft: GRAPH_PAD.left }]}>
        {[20, 100, 1000, 10000, 20000].map(freq => (
          <Text
            key={freq}
            style={[
              styles.freqLabel,
              { color: t.colors.textHint },
              {
                position: 'absolute',
                left: (freqToX(freq) - GRAPH_PAD.left) - (plotWidth / 5) / 2 + 2,
              },
            ]}
          >
            {freq >= 1000 ? `${freq / 1000}k` : `${freq}`}
          </Text>
        ))}
      </View>
    </View>
  );
};

// ========== Draggable Node ==========

interface DraggableNodeProps {
  filter: PEQFilter;
  color: string;
  isSelected: boolean;
  /** 释放时提交最终值 */
  onCommit: (freq: number, gain: number) => void;
  onPress: () => void;
  freqToX: (freq: number) => number;
  xToFreq: (x: number) => number;
  gainToY: (gain: number) => number;
  yToGain: (y: number) => number;
}

const NODE_SIZE = 24;

const DraggableNode: React.FC<DraggableNodeProps> = ({
  filter,
  color,
  isSelected,
  onCommit,
  onPress,
  freqToX,
  xToFreq,
  gainToY,
  yToGain,
}) => {
  const startPos = useRef({ x: 0, y: 0 });
  // 拖动中的当前位置（ref，不触发渲染）
  const currentX = useRef(freqToX(filter.frequency));
  const currentY = useRef(gainToY(filter.gain));
  // 最后一次提交的值
  const lastCommittedFreq = useRef(filter.frequency);
  const lastCommittedGain = useRef(filter.gain);
  // 是否正在拖动
  const isDragging = useRef(false);

  // 存储回调引用以避免闭包过期
  const onCommitRef = useRef(onCommit);
  const onPressRef = useRef(onPress);
  onCommitRef.current = onCommit;
  onPressRef.current = onPress;

  // 同步 prop 变化到 ref（当外部 filter 变化时）
  if (!isDragging.current) {
    currentX.current = freqToX(filter.frequency);
    currentY.current = gainToY(filter.gain);
    lastCommittedFreq.current = filter.frequency;
    lastCommittedGain.current = filter.gain;
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        isDragging.current = true;
        startPos.current = { x: currentX.current, y: currentY.current };
      },
      onPanResponderMove: (_, gesture) => {
        // 拖动中仅更新本地 ref，不触发任何状态更新
        const newX = startPos.current.x + gesture.dx;
        const newY = startPos.current.y + gesture.dy;
        currentX.current = Math.max(
          freqToX(FREQ_MIN),
          Math.min(freqToX(FREQ_MAX), newX),
        );
        currentY.current = Math.max(
          gainToY(GAIN_MAX),
          Math.min(gainToY(GAIN_MIN), newY),
        );
      },
      onPanResponderRelease: () => {
        isDragging.current = false;
        // 释放时一次性提交
        const freq = xToFreq(currentX.current);
        const gain = yToGain(currentY.current);
        if (freq !== lastCommittedFreq.current || gain !== lastCommittedGain.current) {
          lastCommittedFreq.current = freq;
          lastCommittedGain.current = gain;
          onCommitRef.current(freq, gain);
        }
        onPressRef.current();
      },
      onPanResponderTerminate: () => {
        isDragging.current = false;
        const freq = xToFreq(currentX.current);
        const gain = yToGain(currentY.current);
        if (freq !== lastCommittedFreq.current || gain !== lastCommittedGain.current) {
          lastCommittedFreq.current = freq;
          lastCommittedGain.current = gain;
          onCommitRef.current(freq, gain);
        }
      },
    }),
  ).current;

  return (
    <View
      style={[
        styles.nodeContainer,
        {
          left: currentX.current - NODE_SIZE / 2,
          top: currentY.current - NODE_SIZE / 2,
        },
      ]}
      {...panResponder.panHandlers}
    >
      {/* 发光光环 */}
      <View
        style={[
          styles.nodeGlow,
          {
            backgroundColor: color + '30',
            borderColor: color,
            borderWidth: isSelected ? 3 : 2,
            opacity: isSelected ? 1 : 0.7,
          },
        ]}
      />
      {/* 节点核心 */}
      <View
        style={[
          styles.nodeCore,
          { backgroundColor: color },
        ]}
      />
    </View>
  );
};

// ========== Helper: 计算单个滤波器在给定频率的响应 ==========

/**
 * 计算 PEQ 滤波器在目标频率的近似增益响应（dB）
 *
 * 使用简化模型：
 * - Peak: 钟形曲线
 * - LowShelf: 低频搁架
 * - HighShelf: 高频搁架
 * - LowPass/HighPass: 渐变截断（简化）
 * - Notch: 反向钟形
 * - BandPass: 通带
 */
function filterResponseAt(filter: PEQFilter, freq: number): number {
  const { type, frequency: f0, gain, q } = filter;
  if (!filter.enabled || gain === 0) return 0;

  const ratio = freq / f0;
  const invRatio = f0 / freq;

  switch (type) {
    case 'Peak': {
      const numerator = ratio * q;
      const denominator = Math.sqrt((ratio * ratio - 1) * (ratio * ratio - 1) + (ratio / q) * (ratio / q));
      const response = numerator / (denominator + 0.001);
      return gain * response;
    }
    case 'LowShelf': {
      const shelf = 1 / Math.sqrt(1 + (ratio * ratio) / (q * q));
      return gain * Math.max(0, shelf);
    }
    case 'HighShelf': {
      const shelf = 1 / Math.sqrt(1 + (invRatio * invRatio) / (q * q));
      return gain * Math.max(0, shelf);
    }
    case 'LowPass': {
      const lp = 1 / Math.sqrt(1 + ratio * ratio);
      return gain * lp;
    }
    case 'HighPass': {
      const hp = 1 / Math.sqrt(1 + invRatio * invRatio);
      return gain * hp;
    }
    case 'Notch': {
      const notch = 1 - 1 / (1 + (ratio - 1 / ratio) * (ratio - 1 / ratio) * q * q);
      return -Math.abs(gain) * notch;
    }
    case 'BandPass': {
      const bp = 1 / Math.sqrt(1 + (ratio - 1 / ratio) * (ratio - 1 / ratio) * q * q);
      return gain * bp;
    }
    default:
      return 0;
  }
}

// ========== Styles ==========

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    marginVertical: 8,
  },
  scaleLabels: {
    position: 'absolute',
    left: 0,
    top: GRAPH_PAD.top - 6,
    bottom: GRAPH_PAD.bottom,
    width: 28,
    justifyContent: 'space-between',
    zIndex: 10,
  },
  scaleLabel: {
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'right',
  },
  graphArea: {
    marginLeft: 32,
    position: 'relative',
    overflow: 'visible',
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    opacity: 0.3,
  },
  centerLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1.5,
  },
  curveContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  curveSegment: {
    position: 'absolute',
    borderRadius: 1,
  },
  emptyHint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 12,
    fontWeight: '500',
  },
  freqLabels: {
    flexDirection: 'row',
    marginTop: 4,
    height: 16,
    position: 'relative',
  },
  freqLabel: {
    fontSize: 8,
    fontWeight: '500',
    width: 32,
    textAlign: 'center',
  },
  nodeContainer: {
    position: 'absolute',
    width: NODE_SIZE,
    height: NODE_SIZE,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  nodeGlow: {
    position: 'absolute',
    width: NODE_SIZE + 8,
    height: NODE_SIZE + 8,
    borderRadius: (NODE_SIZE + 8) / 2,
  },
  nodeCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
