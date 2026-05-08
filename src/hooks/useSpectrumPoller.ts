/**
 * useSpectrumPoller - 实时频谱数据轮询 Hook
 *
 * 以固定间隔从 Native DSPAudioProcessor 获取 FFT 频谱数据，
 * 供 SpectrumView 组件渲染。
 *
 * 数据流：
 *   DSPAudioProcessor.fftAnalyzer.spectrum
 *     → AudioDSPModule.getSpectrumData() [Native Bridge]
 *       → useSpectrumPoller [JS, ~80ms polling]
 *         → SpectrumView.spectrumData prop [Native UI Component]
 *           → SpectrumGLSurfaceView.updateSpectrum() [OpenGL ES 2.0]
 *
 * 包含指数移动平均 (EMA) 平滑，减少帧间视觉跳动。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import LoggerService from '../services/LoggerService';
import { audioDSP } from '../native/AudioDSPModule';

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 80; // ~12.5 fps，平衡性能与流畅度

/**
 * 指数移动平均平滑因子
 *
 * 【重要】原生层 (FFTAnalyzer + SpectrumRenderer) 已实现精密的非对称平滑、
 * AGC 自适应增益控制与重力衰减物理引擎。JS 层的平滑仅作为轮询间隔
 * (80ms) 桥接补偿，大幅降低以避免干扰原生动画手感。
 * 0=不平滑, 0.9=强平滑 — 当前 0.15 仅做最轻量的帧间过渡。
 */
const SMOOTHING_FACTOR = 0.15;

/** 调试模式：打印频谱数据长度（仅在开发环境生效） */
const DEBUG = __DEV__;

export interface SpectrumData {
  /** 128-bin 频谱幅度 (0~1) */
  spectrum: number[];
  /** 猫耳左声道 16-bin */
  catEarLeft: number[];
  /** 猫耳右声道 16-bin */
  catEarRight: number[];
}

/**
 * 对两个等长数组应用 EMA 平滑
 */
function smoothArray(prev: number[], next: number[], factor: number): number[] {
  if (prev.length === 0) return next;
  const len = Math.min(prev.length, next.length);
  const result = new Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = prev[i] * factor + next[i] * (1 - factor);
  }
  return result;
}

/**
 * 实时频谱数据 Hook
 *
 * @param enabled 是否启用轮询（页面显示时启用，离开时停用）
 * @returns 当前频谱数据，包含 spectrum / catEarLeft / catEarRight
 */
export function useSpectrumPoller(enabled: boolean = true): SpectrumData {
  const [data, setData] = useState<SpectrumData>({
    spectrum: [],
    catEarLeft: [],
    catEarRight: [],
  });

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // 存储上一帧的平滑数据
  const smoothRef = useRef<SpectrumData>({
    spectrum: [],
    catEarLeft: [],
    catEarRight: [],
  });

  const poll = useCallback(async () => {
    // 仅在 Android 上有效
    if (Platform.OS !== 'android') return;

    try {
      const result = await audioDSP.getSpectrumData();
      if (
        result &&
        result.spectrum &&
        result.spectrum.length > 0
      ) {
        // 应用 EMA 平滑
        const smoothedSpectrum = smoothArray(smoothRef.current.spectrum, result.spectrum, SMOOTHING_FACTOR);
        const smoothedLeft = smoothArray(smoothRef.current.catEarLeft, result.catEarLeft ?? [], SMOOTHING_FACTOR);
        const smoothedRight = smoothArray(smoothRef.current.catEarRight, result.catEarRight ?? [], SMOOTHING_FACTOR);

        // 更新平滑缓存
        smoothRef.current = {
          spectrum: smoothedSpectrum,
          catEarLeft: smoothedLeft,
          catEarRight: smoothedRight,
        };

        setData({
          spectrum: smoothedSpectrum,
          catEarLeft: smoothedLeft,
          catEarRight: smoothedRight,
        });

        if (DEBUG) {
          LoggerService.debug(
            'useSpectrumPoller',
            'poll',
            `spectrum=${smoothedSpectrum.length} bins, ` +
            `left=${smoothedLeft.length} bins, right=${smoothedRight.length} bins`,
          );
        }
      } else if (DEBUG) {
        LoggerService.warn('useSpectrumPoller', 'poll', 'Native getSpectrumData() returned empty data');
      }
    } catch (e) {
      if (DEBUG) {
        LoggerService.warn('useSpectrumPoller', 'poll', 'Native module error:', e);
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled || Platform.OS !== 'android') return;

    // 启动轮询
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    // 立即执行一次
    poll();

    // 监听 AppState 变化，后台时暂停轮询以省电
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      const prevState = appStateRef.current;
      appStateRef.current = nextState;

      if (prevState === 'active' && (nextState === 'background' || nextState === 'inactive')) {
        // 进入后台 → 停止轮询
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else if ((prevState === 'background' || prevState === 'inactive') && nextState === 'active') {
        // 回到前台 → 恢复轮询
        intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
        poll();
      }
    });

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      subscription.remove();
    };
  }, [enabled, poll]);

  return data;
}
