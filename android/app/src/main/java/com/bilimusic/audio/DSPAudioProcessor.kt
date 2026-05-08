package com.bilimusic.audio

import com.bilimusic.audio.filter.BiquadFilter
import com.bilimusic.audio.filter.RBJFilter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

/**
 * 基于 ExoPlayer/Media3 BaseAudioProcessor 模式的 DSP 引擎
 *
 * 音频链：
 * ExoPlayer → PCM Float Buffer → DSPAudioProcessor → FFT Analyzer → AudioTrack
 *
 * 注意：由于 react-native-track-player 封装了 ExoPlayer，
 * 在集成阶段需要通过自定义 AudioProcessor 注册到 TrackPlayer 的 MediaSource 中。
 * 当前实现提供完整的 DSP 逻辑，可通过 AudioDSPModule 桥接调用。
 */
class DSPAudioProcessor {

    companion object {
        @Volatile
        var instance: DSPAudioProcessor? = null
    }

    // 10-band Graphic EQ 滤波器
    private val graphicFilters = Array(10) { BiquadFilter() }

    // PEQ 8 个滤波器
    private val peqFilters = Array(8) { RBJFilter() }

    // FFT 频谱分析器
    val fftAnalyzer = FFTAnalyzer(1024)

    // 配置锁，保证线程安全
    private val lock = ReentrantReadWriteLock()

    // EQ 状态
    var enabled = true
        private set
    var mode: EQMode = EQMode.GRAPHIC
        private set

    // Graphic EQ 频段频率
    private val bandFrequencies = floatArrayOf(
        31f, 62f, 125f, 250f, 500f,
        1000f, 2000f, 4000f, 8000f, 16000f
    )

    // Limiter 参数
    private var limiterThreshold = 0.95f
    private var limiterEnabled = true

    enum class EQMode { GRAPHIC, PARAMETRIC }

    init {
        // 注册全局实例（供 ExoPlayer AudioProcessor 注入使用）
        instance = this

        // 初始化 Graphic EQ 滤波器（默认平直曲线）
        for (i in graphicFilters.indices) {
            graphicFilters[i].sampleRate = 44100f
            graphicFilters[i].setPeak(bandFrequencies[i], 0f, 1.0f)
        }

        // 初始化 PEQ 滤波器
        for (filter in peqFilters) {
            filter.sampleRate = 44100f
            filter.calculateCoefficients()
        }
    }

    // ====== 配置方法（从 JS 通过 Bridge 调用） ======

    fun setEnabled(enabled: Boolean) {
        lock.write { this.enabled = enabled }
    }

    fun setMode(mode: EQMode) {
        lock.write { this.mode = mode }
    }

    /**
     * 更新 Graphic EQ 10 个频段的增益
     *
     * @param gains 长度为 10 的 float 数组，范围 -12 ~ +12 dB
     */
    fun updateGraphicEQ(gains: FloatArray) {
        if (gains.size != 10) return
        lock.write {
            for (i in 0 until 10) {
                graphicFilters[i].setPeak(bandFrequencies[i], gains[i].coerceIn(-12f, 12f), 1.0f)
            }
        }
    }

    /**
     * 更新 PEQ 单个滤波器的参数
     *
     * @param index 滤波器索引 (0-7)
     * @param type 滤波器类型 (0=Peak, 1=LowShelf, 2=HighShelf, 3=LowPass, 4=HighPass, 5=Notch, 6=BandPass)
     * @param frequency 频率 (Hz)
     * @param gain 增益 (dB)
     * @param q Q 值
     */
    fun updatePEQFilter(index: Int, type: Int, frequency: Float, gain: Float, q: Float) {
        if (index < 0 || index >= 8) return
        lock.write {
            val filter = peqFilters[index]
            filter.type = RBJFilter.Type.values()[type.coerceIn(0, 6)]
            filter.frequency = frequency
            filter.gain = gain
            filter.q = q.coerceIn(0.1f, 20f)
            filter.calculateCoefficients()
        }
    }

    /**
     * 应用预设（快捷设置所有频段）
     */
    fun applyPreset(gains: FloatArray) {
        if (gains.size != 10) return
        updateGraphicEQ(gains)
    }

    // ====== 音频处理 ======

    /**
     * 处理 PCM Float 缓冲区
     *
     * 这是整个 DSP 链路的入口，在音频渲染线程调用。
     *
     * @param buffer PCM Float32 数据
     * @param channels 声道数
     * @return 处理后的缓冲区
     */
    fun process(buffer: FloatArray, channels: Int = 2): FloatArray {
        if (!enabled) {
            // 即使 EQ 关闭，也继续 FFT 分析用于频谱显示
            fftAnalyzer.analyze(buffer, channels)
            return buffer
        }

        lock.read {
            when (mode) {
                EQMode.GRAPHIC -> {
                    // 串联 10 个 Biquad 滤波器
                    for (filter in graphicFilters) {
                        filter.process(buffer)
                    }
                }
                EQMode.PARAMETRIC -> {
                    // 串联 8 个 RBJ 滤波器
                    for (filter in peqFilters) {
                        filter.process(buffer)
                    }
                }
            }
        }

        // 简易 Limiter（防止削波失真）
        if (limiterEnabled) {
            applyLimiter(buffer)
        }

        // FFT 分析用于频谱可视化
        fftAnalyzer.analyze(buffer, channels)

        return buffer
    }

    /**
     * 处理 ByteBuffer 格式的 PCM 数据 (Media3 AudioProcessor 格式)
     */
    fun processByteBuffer(inputBuffer: ByteBuffer, channels: Int): ByteBuffer {
        inputBuffer.order(ByteOrder.LITTLE_ENDIAN)
        val floatCount = inputBuffer.remaining() / 4
        val floatBuffer = FloatArray(floatCount)

        // ByteBuffer → FloatArray
        inputBuffer.asFloatBuffer().get(floatBuffer)

        // DSP 处理
        process(floatBuffer, channels)

        // FloatArray → ByteBuffer
        val output = ByteBuffer.allocateDirect(floatCount * 4)
        output.order(ByteOrder.LITTLE_ENDIAN)
        val outFloat = output.asFloatBuffer()
        outFloat.put(floatBuffer)
        output.position(0)

        return output
    }

    // ====== Limiter ======

    private fun applyLimiter(buffer: FloatArray) {
        var peak = 0f
        for (sample in buffer) {
            val abs = kotlin.math.abs(sample)
            if (abs > peak) peak = abs
        }

        if (peak > limiterThreshold) {
            val gain = limiterThreshold / peak
            for (i in buffer.indices) {
                buffer[i] *= gain
            }
        }
    }

    /**
     * 重置所有滤波器和 FFT 状态
     */
    fun reset() {
        lock.write {
            for (filter in graphicFilters) filter.reset()
            for (filter in peqFilters) filter.reset()
            fftAnalyzer.reset()
        }
    }
}
