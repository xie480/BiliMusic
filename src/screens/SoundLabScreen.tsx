import React, { useState, useCallback, useRef, useEffect, memo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Animated,
  Dimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header } from '../components/Header';
import { Switch } from '../components/Switch';
import { useTheme } from '../theme';
import { useEQStore, BAND_FREQUENCIES, GraphicBands, EMOTION_PRESETS } from '../store/eqStore';
import { GraphicEQ } from '../components/eq/GraphicEQ';
import { ParametricEQ } from '../components/eq/ParametricEQ';
import { PEQFilterEditor } from '../components/eq/PEQFilterEditor';
import { PresetSelector } from '../components/eq/PresetSelector';
import { SpectrumView } from '../components/eq/SpectrumView';
import { useSpectrumPoller } from '../hooks/useSpectrumPoller';
import type { EQMode } from '../store/eqStore';

// ========== Styles（定义在组件之前，避免 Hermes TDZ 问题） ==========
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },

  // 底部固定 EQ 控制台
  bottomConsole: {
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 16,
  },

  // EQ 控制栏
  controlBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  switchLabel: {
    fontSize: 15,
    fontWeight: '600',
  },

  // 模式切换
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  modeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 10,
  },
  modeBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },

  // 预设指示
  presetLabel: {
    fontSize: 11,
    fontWeight: '500',
  },

  // EQ 区域可滚动容器
  eqScrollArea: {
    marginTop: 4,
    marginHorizontal: -16,
    paddingHorizontal: 16,
  },

  // PEQ 紧凑布局
  peqCompact: {
    minWidth: 300,
  },

  // PEQ 滤波器行
  peqFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  peqFilterScroll: {
    flex: 1,
  },
  peqFilterChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    borderWidth: 0,
    minWidth: 70,
    marginRight: 4,
  },
  peqFilterChipText: {
    fontSize: 10,
    fontWeight: '600',
  },
  peqFilterChipSub: {
    fontSize: 8,
    fontWeight: '400',
    marginTop: 1,
  },

  // 添加滤波器小按钮
  addFilterBtnSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  addFilterBtnText: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 18,
  },

  // PEQ 编辑器容器
  peqEditorContainer: {
    marginTop: 4,
  },

  // 预设区域
  presetSection: {
    marginTop: 12,
    marginHorizontal: 16,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  resetBtn: {
    fontSize: 13,
    fontWeight: '500',
  },

  // 频谱
  spectrumCard: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    overflow: 'hidden',
    padding: 16,
  },
  spectrumView: {
    width: '100%',
    height: 100,
    marginTop: 8,
    borderRadius: 12,
  },

  // 频段详情
  detailCard: {
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 16,
    overflow: 'hidden',
    padding: 16,
  },
  bandGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    alignItems: 'center',
  },
  bandItem: {
    alignItems: 'center',
    width: 32,
  },
  bandFreq: {
    fontSize: 8,
    fontWeight: '600',
    marginBottom: 4,
  },
  bandValue: {
    fontSize: 9,
    fontWeight: '700',
    marginBottom: 4,
  },
  miniBar: {
    borderRadius: 2,
  },
});

const MODE_OPTIONS: Array<{ key: EQMode; label: string }> = [
  { key: 'graphic', label: '图形 EQ' },
  { key: 'parametric', label: '参数 EQ' },
];

// ========== 频段详情组件（独立 memo 避免主组件重渲染时重建） ==========
interface BandDetailProps {
  graphicBands: GraphicBands;
}

const BandDetail = memo<BandDetailProps>(({ graphicBands }) => {
  const t = useTheme();

  return (
    <View style={[styles.detailCard, { backgroundColor: t.colors.surface }]}>
      <Text style={[styles.sectionTitle, { color: t.colors.text }]}>
        频段详情
      </Text>
      <View style={styles.bandGrid}>
        {BAND_FREQUENCIES.map((freq, i) => (
          <View key={freq} style={styles.bandItem}>
            <Text style={[styles.bandFreq, { color: t.colors.textSub }]}>
              {freq}Hz
            </Text>
            <Text
              style={[
                styles.bandValue,
                {
                  color:
                    graphicBands[i] > 0
                      ? t.colors.primary
                      : graphicBands[i] < 0
                      ? '#6C5CE7'
                      : t.colors.textHint,
                },
              ]}
            >
              {graphicBands[i] > 0 ? '+' : ''}{graphicBands[i]} dB
            </Text>
            {/* 迷你能量条 */}
            <View
              style={[
                styles.miniBar,
                {
                  width: 4,
                  height: Math.abs(graphicBands[i]) * 4 + 4,
                  backgroundColor:
                    graphicBands[i] > 0
                      ? t.colors.primary
                      : '#6C5CE7',
                },
              ]}
            />
          </View>
        ))}
      </View>
    </View>
  );
});

export const SoundLabScreen = () => {
  const t = useTheme();
  const insets = useSafeAreaInsets();

  // EQ State - 仅订阅必要的状态，graphicBands 不下放到这里
  const mode = useEQStore(s => s.mode);
  const setMode = useEQStore(s => s.setMode);
  const enabled = useEQStore(s => s.enabled);
  const setEnabled = useEQStore(s => s.setEnabled);
  const activePresetId = useEQStore(s => s.activePresetId);
  const resetToFlat = useEQStore(s => s.resetToFlat);

  // PEQ 本地状态
  const [selectedFilterId, setSelectedFilterId] = useState<number | null>(null);

  // 当前预设名称
  const activePreset = EMOTION_PRESETS.find(p => p.id === activePresetId);

  // FFT 频谱数据轮询（EQ 启用时持续轮询，覆盖所有模式）
  const { spectrum, catEarLeft, catEarRight } = useSpectrumPoller(enabled);

  return (
    <View style={[styles.safeArea, { backgroundColor: t.colors.background }]}>
      <StatusBar
        barStyle={t.isDark ? 'light-content' : 'dark-content'}
        translucent
        backgroundColor="transparent"
      />
      <Header title="声音实验室" showBack noBorder />

      {/* ---- 上部可滚动内容区 ---- */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* ===== 预设选择器 ===== */}
        <View style={styles.presetSection}>
          <View style={styles.sectionTitleRow}>
            <Text style={[styles.sectionTitle, { color: t.colors.text }]}>
              情绪化预设
            </Text>
            {activePresetId !== 'flat' && (
              <TouchableOpacity onPress={resetToFlat}>
                <Text style={[styles.resetBtn, { color: t.colors.primary }]}>
                  重置
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <PresetSelector />
        </View>

        {/* ===== FFT 频谱区域（Native OpenGL SpectrumView） ===== */}
        <View style={[styles.spectrumCard, { backgroundColor: t.colors.surface }]}>
          <Text style={[styles.sectionTitle, { color: t.colors.text }]}>
            实时频谱
          </Text>
          <SpectrumView
            style={styles.spectrumView}
            spectrumData={spectrum}
            catEarLeft={catEarLeft}
            catEarRight={catEarRight}
          />
        </View>

        {/* ===== 频段详情（仅 Graphic EQ 模式，使用独立组件） ===== */}
        {mode === 'graphic' && <BandDetailView />}
      </ScrollView>

      {/* ---- 底部固定 EQ 控制台 ---- */}
      <View
        style={[
          styles.bottomConsole,
          {
            backgroundColor: t.colors.surface,
            borderTopColor: t.colors.divider,
            zIndex: 100,
          },
        ]}
      >
        {/* EQ 开关 + 模式切换 */}
        <View style={styles.controlBar}>
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: t.colors.text }]}>
              EQ 均衡器
            </Text>
            <Switch value={enabled} onValueChange={setEnabled} />
          </View>
          {/* 当前预设标签 */}
          {activePreset && (
            <Text style={[styles.presetLabel, { color: t.colors.textHint }]}>
              预设：<Text style={{ color: t.colors.primary }}>{activePreset.name}</Text>
            </Text>
          )}
        </View>

        {/* 模式选择器 */}
        <View style={styles.modeRow}>
          {MODE_OPTIONS.map(opt => {
            const isActive = mode === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                activeOpacity={0.7}
                onPress={() => setMode(opt.key)}
                style={[
                  styles.modeBtn,
                  isActive
                    ? { backgroundColor: t.colors.primary + '25', borderColor: t.colors.primary, borderWidth: 1.5 }
                    : { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: 'transparent', borderWidth: 1 },
                ]}
              >
                <Text
                  style={[
                    styles.modeBtnText,
                    { color: isActive ? t.colors.primary : t.colors.textSub },
                  ]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ===== Graphic EQ 区域 ===== */}
        {mode === 'graphic' && (
          <View style={[styles.eqScrollArea, { opacity: enabled ? 1 : 0.35 }]}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              bounces={false}
              nestedScrollEnabled
            >
              <GraphicEQ />
            </ScrollView>
          </View>
        )}

        {/* ===== PEQ 区域 ===== */}
        {mode === 'parametric' && (
          <PEQSection
            selectedFilterId={selectedFilterId}
            onSelectFilter={setSelectedFilterId}
          />
        )}
      </View>
    </View>
  );
};

// ========== BandDetailView - 从 store 读取 graphicBands 的独立组件 ==========
const BandDetailView = memo(() => {
  const graphicBands = useEQStore(s => s.graphicBands);
  return <BandDetail graphicBands={graphicBands} />;
});

// ========== PEQSection - PEQ 区域的独立组件 ==========
interface PEQSectionProps {
  selectedFilterId: number | null;
  onSelectFilter: (id: number | null) => void;
}

const PEQSection = memo<PEQSectionProps>(({ selectedFilterId, onSelectFilter }) => {
  const t = useTheme();
  const peqFilters = useEQStore(s => s.peqFilters);
  const addFilter = useEQStore(s => s.addFilter);
  const enabled = useEQStore(s => s.enabled);

  // 当前选中的 PEQ 滤波器
  const selectedFilter = selectedFilterId
    ? peqFilters.find(f => f.id === selectedFilterId) ?? null
    : null;

  return (
    <View style={[styles.eqScrollArea, { opacity: enabled ? 1 : 0.35 }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        bounces={false}
        nestedScrollEnabled
      >
        <View style={styles.peqCompact}>
          {/* 频率响应曲线 + 可拖动节点 */}
          <ParametricEQ
            filters={peqFilters}
            onSelectFilter={onSelectFilter}
            selectedFilterId={selectedFilterId}
          />
        </View>
      </ScrollView>

      {/* 紧凑型滤波器列表 + 添加按钮 */}
      <View style={styles.peqFilterRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.peqFilterScroll}
        >
          {peqFilters.map(filter => (
            <TouchableOpacity
              key={filter.id}
              activeOpacity={0.7}
              onPress={() => onSelectFilter(
                selectedFilterId === filter.id ? null : filter.id,
              )}
              style={[
                styles.peqFilterChip,
                {
                  backgroundColor: filter.enabled
                    ? t.colors.primary + '18'
                    : 'rgba(255,255,255,0.05)',
                  borderColor: selectedFilterId === filter.id
                    ? t.colors.primary
                    : 'transparent',
                  borderWidth: selectedFilterId === filter.id ? 1.5 : 0,
                },
              ]}
            >
              <Text
                style={[
                  styles.peqFilterChipText,
                  {
                    color: filter.enabled ? t.colors.primary : t.colors.textSub,
                    opacity: filter.enabled ? 1 : 0.5,
                  },
                ]}
              >
                #{filter.id} {filter.type}
              </Text>
              <Text style={[styles.peqFilterChipSub, { color: t.colors.textHint }]}>
                {filter.frequency >= 1000
                  ? `${(filter.frequency / 1000).toFixed(1)}k`
                  : `${filter.frequency}`}
                Hz · {filter.gain > 0 ? '+' : ''}{filter.gain}dB
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            addFilter();
            onSelectFilter(
              peqFilters.length > 0 ? Math.max(...peqFilters.map(f => f.id)) + 1 : 1,
            );
          }}
          style={[
            styles.addFilterBtnSmall,
            { borderColor: t.colors.primary + '40', backgroundColor: t.colors.primary + '0A' },
          ]}
        >
          <Text style={[styles.addFilterBtnText, { color: t.colors.primary }]}>+</Text>
        </TouchableOpacity>
      </View>

      {/* 选中滤波器的编辑面板（在底部弹出） */}
      {selectedFilter && (
        <View style={styles.peqEditorContainer}>
          <PEQFilterEditor
            filter={selectedFilter}
            onClose={() => onSelectFilter(null)}
          />
        </View>
      )}
    </View>
  );
});
