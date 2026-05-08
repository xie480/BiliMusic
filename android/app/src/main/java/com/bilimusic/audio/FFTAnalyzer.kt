package com.bilimusic.audio

import kotlin.math.*
import kotlin.concurrent.Volatile

/**
 * FFT 实时频谱分析器 - 增强版
 *
 * 核心优化：
 * 1. **自适应增益控制 (AGC)**：动态跟踪频谱能量，自动调节参考电平，
 *    避免低音量时过于稀疏、高音量时满量程饱和。
 * 2. **软膝压缩曲线**：对峰值进行非线性压缩，保留动态起伏的同时防止触顶。
 * 3. **频段权重补偿**：基于等响曲线原理压制低频、适当提升中高频，
 *    使各频段在视觉上表现更均衡。
 * 4. **非对称平滑**：攻击快、释放慢，保留瞬态冲击感的同时减少抖动。
 *
 * 使用 Cooley-Tukey Radix-2 FFT 算法对 PCM Float 缓冲区的
 * 时域信号进行频域变换，输出频段的幅度谱用于可视化渲染。
 */
class FFTAnalyzer(private val fftSize: Int = 1024) {

    private val window = hanningWindow(fftSize)
    private var real = FloatArray(fftSize)
    private var imag = FloatArray(fftSize)

    // ====== 频谱输出 ======
    @Volatile
    var spectrum = FloatArray(fftSize / 2)
        private set

    @Volatile
    var catEarLeft = FloatArray(16)
        private set

    @Volatile
    var catEarRight = FloatArray(16)
        private set

    // ====== 内部平滑状态 ======
    private var smoothedSpectrum = FloatArray(fftSize / 2)

    // ====== AGC 状态 ======
    private var agcEnergy = 0f              // 平滑后的平均能量估计 (dB)
    private var agcCeiling = -18f           // 动态天花板 (dB)，自动调节
    private var agcFloor = -72f             // 动态地板 (dB)，跟随天花板偏移

    // ====== AGC 参数 ======
    private val agcAttackTime = 0.30f       // 攻击速度：能量上升时快速响应
    private val agcReleaseTime = 0.04f      // 释放速度：能量下降时缓慢释放
    private val agcTargetHeadroom = 12f      // 目标净空：天花板比峰值高 6dB
    private val agcCeilingMin = -30f        // 天花板最小值（最灵敏）
    private val agcCeilingMax = -12f        // 天花板最大值（最不灵敏）
    private val agcDynamicRange = 48f       // 动态范围：天花板 - 地板

    // ====== 压缩参数 ======
    private val kneeStart = 0.60f           // 软膝起始点 (归一化值)
    private val compressionRatio = 5f     // 压缩比 (>1 表示压缩)
    private val kneeWidth = 0.15f           // 软膝过渡宽度

    // ====== 频段权重 ======
    // 预计算的等响曲线补偿权重 (简化版 Fletcher-Munson)
    // 目的：压制过于强势的低频，适当突出中高频细节
    private val bandWeights: FloatArray

    // ====== 平滑参数 ======
    private var attackSmooth = 0.40f        // 上升平滑因子 (快速)
    private var releaseSmooth = 0.08f       // 下降平滑因子 (慢速)

    init {
        // 预计算频段权重 (索引 0 ~ fftSize/2-1)
        bandWeights = FloatArray(fftSize / 2) { i ->
            val normIdx = i.toFloat() / (fftSize / 2 - 1f) // 0.0 ~ 1.0
            when {
                // 极低频 (0 ~ 0.06): 强烈压制，防止低频驻波淹没画面
                normIdx < 0.06f -> 0.20f + normIdx / 0.06f * 0.40f
                // 低频 (0.06 ~ 0.15): 渐进释放
                normIdx < 0.15f -> 0.60f + (normIdx - 0.06f) / 0.09f * 0.40f
                // 中低频 (0.15 ~ 0.25): 轻微压制
                normIdx < 0.25f -> 1.00f - (normIdx - 0.15f) / 0.10f * 0.15f
                // 中频 (0.25 ~ 0.55): 平坦区，人声主导
                normIdx < 0.55f -> 0.85f
                // 中高频 (0.55 ~ 0.75): 轻微提升，增加细节
                normIdx < 0.75f -> 0.85f + (normIdx - 0.55f) / 0.20f * 0.25f
                // 高频 (0.75 ~ 0.92): 提升区
                normIdx < 0.92f -> 1.10f
                // 极高频 (0.92 ~ 1.0): 自然衰减
                else -> 1.10f - (normIdx - 0.92f) / 0.08f * 0.40f
            }
        }
    }

    /**
     * 处理 PCM Float 缓冲区并更新频谱
     *
     * @param pcmBuffer PCM Float32 音频数据
     * @param channels 声道数 (1=mono, 2=stereo)
     */
    fun analyze(pcmBuffer: FloatArray, channels: Int = 2) {
        // 将多声道混合为单声道，填充 FFT 缓冲区
        val step = if (channels >= 2) 2 else 1
        val len = min(pcmBuffer.size / step, fftSize)

        for (i in 0 until len) {
            real[i] = pcmBuffer[i * step] * window[i]
            imag[i] = 0f
        }

        // 剩余补零
        for (i in len until fftSize) {
            real[i] = 0f
            imag[i] = 0f
        }

        // 执行 FFT
        fft(real, imag)

        // ==========================================
        // 第 1 步：计算幅度谱并转为 dB
        // ==========================================
        val halfSize = fftSize / 2
        val dBValues = FloatArray(halfSize)
        var peakDb = -80f
        var avgEnergy = 0f

        for (i in 0 until halfSize) {
            val magnitude = sqrt(real[i] * real[i] + imag[i] * imag[i].toDouble()).toFloat()
            val dB = 20f * log10(magnitude + 1e-10f)
            dBValues[i] = dB
            if (dB > peakDb) peakDb = dB
            avgEnergy += dB
        }
        avgEnergy /= halfSize

        // ==========================================
        // 第 2 步：AGC — 自适应动态天花板
        // ==========================================
        // 估计当前音频能量水平：使用峰值 + 净空，而不是平均值
        // 这样天花板会跟随歌曲的整体响度变化
        val targetCeiling = (peakDb + agcTargetHeadroom).coerceIn(
            agcCeilingMin, agcCeilingMax
        )

        // 攻击/释放非对称：能量上升时快速拉高天花板，下降时缓慢降低
        val agcSpeed = if (targetCeiling > agcEnergy) agcAttackTime else agcReleaseTime
        agcEnergy = agcEnergy * (1f - agcSpeed) + targetCeiling * agcSpeed

        agcCeiling = agcEnergy
        agcFloor = agcCeiling - agcDynamicRange

        // ==========================================
        // 第 3 步：dB 归一化 + 软膝压缩 + 频段权重
        // ==========================================
        val dynamicRange = (agcCeiling - agcFloor).coerceAtLeast(24f) // 至少 24dB 范围
        val newSpectrum = FloatArray(halfSize)

        for (i in 0 until halfSize) {
            val dB = dBValues[i]

            // (a) 动态归一化：将 dB 映射到 [0, 1]，参考点随 AGC 浮动
            var normalized = ((dB - agcFloor) / dynamicRange).coerceIn(0f, 1f)

            // (b) 软膝压缩：对高能量频段进行非线性压缩
            //     在 kneeStart 之前保持线性，之后逐渐压缩
            if (normalized > kneeStart - kneeWidth / 2f) {
                val kneeEnd = kneeStart + kneeWidth / 2f
                if (normalized < kneeStart + kneeWidth / 2f) {
                    // 软膝过渡区：平滑插值
                    val t = (normalized - (kneeStart - kneeWidth / 2f)) / kneeWidth
                    val linearVal = normalized
                    val compressedVal = kneeStart + (normalized - kneeStart) / compressionRatio
                    normalized = linearVal * (1f - t) + compressedVal * t
                } else {
                    // 完全压缩区
                    normalized = kneeStart + (normalized - kneeStart) / compressionRatio
                }
            }

            // (c) 频段权重补偿
            val weighted = normalized * bandWeights[i]

            // (d) 噪声门：低于 -72dB (约 normalized < 0.05) 的信号直接归零
            newSpectrum[i] = if (weighted < 0.02f) {
                0f
            } else {
                weighted.coerceIn(0f, 1f)
            }
        }

        // ==========================================
        // 第 4 步：非对称 EMA 平滑 (攻击快、释放慢)
        // ==========================================
        for (i in smoothedSpectrum.indices) {
            val current = smoothedSpectrum[i]
            val target = newSpectrum[i]

            if (target > current) {
                // 上升：快速跟踪瞬态
                smoothedSpectrum[i] = current * (1f - attackSmooth) + target * attackSmooth
            } else {
                // 下降：慢速衰减，产生拖尾余韵
                // 额外重力因子：高度越高，初始下落越快
                val gravityBoost = 0.05f + 0.12f * (current * current)
                val effectiveRelease = (releaseSmooth + gravityBoost).coerceAtMost(0.40f)
                smoothedSpectrum[i] = current * (1f - effectiveRelease) + target * effectiveRelease
            }
        }

        spectrum = smoothedSpectrum.copyOf()

        // 生成猫耳频谱数据
        updateCatEarData(spectrum)
    }

    /**
     * 更新猫耳动态频谱数据
     *
     * 原理：
     * - 左耳 = 右声道高频 (频谱后半段)
     * - 右耳 = 左声道高频 (频谱后半段)
     * - 低频映射到底部，高频映射到耳尖
     */
    private fun updateCatEarData(monoSpectrum: FloatArray) {
        val earBins = 16
        val startBin = monoSpectrum.size / 3 // 从高频区开始
        val binStep = max(1, (monoSpectrum.size - startBin) / earBins)

        for (i in 0 until earBins) {
            val idx = startBin + i * binStep
            if (idx < monoSpectrum.size) {
                val value = monoSpectrum[idx].coerceIn(0f, 1f)
                catEarLeft[i] = value
                catEarRight[i] = value
            }
        }
    }

    /**
     * 重置分析器状态
     */
    fun reset() {
        spectrum.fill(0f)
        smoothedSpectrum.fill(0f)
        catEarLeft.fill(0f)
        catEarRight.fill(0f)
        agcEnergy = 0f
        agcCeiling = -18f
        agcFloor = -72f
    }

    // ======================
    // FFT Implementation
    // ======================

    /**
     * Cooley-Tukey Radix-2 蝶形 FFT (in-place)
     */
    private fun fft(real: FloatArray, imag: FloatArray) {
        val n = real.size
        require(n > 0 && (n and (n - 1)) == 0) { "FFT size must be power of 2" }

        // 位反转排序
        var j = 0
        for (i in 0 until n) {
            if (i < j) {
                val tr = real[j]; real[j] = real[i]; real[i] = tr
                val ti = imag[j]; imag[j] = imag[i]; imag[i] = ti
            }
            var m = n shr 1
            while (m > 0 && j >= m) {
                j -= m
                m = m shr 1
            }
            j += m
        }

        // 蝶形运算
        var step = 1
        while (step < n) {
            val halfStep = step
            step = step shl 1
            val wlen = (-2.0 * PI / step).toFloat()

            for (k in 0 until n step step) {
                var wr = 1f
                var wi = 0f

                for (m in 0 until halfStep) {
                    val j = k + m
                    val i2 = j + halfStep

                    val tr = wr * real[i2] - wi * imag[i2]
                    val ti = wr * imag[i2] + wi * real[i2]

                    real[i2] = real[j] - tr
                    imag[i2] = imag[j] - ti
                    real[j] += tr
                    imag[j] += ti

                    // 旋转因子更新
                    val angle = wlen * (m + 1)
                    wr = cos(angle)
                    wi = sin(angle)
                }
            }
        }
    }

    companion object {
        /**
         * Hanning 窗函数
         */
        fun hanningWindow(size: Int): FloatArray {
            val w = FloatArray(size)
            for (i in 0 until size) {
                w[i] = (0.5f * (1f - cos(2.0 * PI * i / (size - 1)))).toFloat()
            }
            return w
        }
    }
}
