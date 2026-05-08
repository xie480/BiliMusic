package com.bilimusic.audio

import android.util.Log
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.audio.AudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * ExoPlayer AudioProcessor 适配器
 *
 * 将 DSPAudioProcessor 封装为 ExoPlayer 标准音频处理器，
 * 注入到 ExoPlayer 的音频渲染管线中，使 EQ 调整实时生效，
 * 同时为频谱分析器提供 PCM 数据流。
 *
 * 线程安全：ExoPlayer 在音频处理线程调用，DSPAudioProcessor 内部使用
 * ReentrantReadWriteLock 保证线程安全。
 *
 * 支持的 PCM 格式：
 * - ENCODING_PCM_FLOAT (32-bit float, 4字节/样本)
 * - ENCODING_PCM_16BIT (16-bit integer, 2字节/样本)
 */
class EqAudioProcessorAdapter(
    private val dspProcessor: DSPAudioProcessor
) : AudioProcessor {

    companion object {
        private const val TAG = "EqAudioProcessor"
    }

    /** 当前待输出的处理后的缓冲区 */
    private var pendingOutputBuffer: ByteBuffer = AudioProcessor.EMPTY_BUFFER

    /** 输入是否已结束 */
    private var inputEnded = false

    /** 当前输入格式参数 */
    private var inputSampleRate = 44100
    private var inputChannelCount = 2
    private var inputEncoding = C.ENCODING_PCM_FLOAT

    /**
     * 临时缓冲区（16-bit → float 转换用）
     * 复用避免频繁分配
     */
    private var conversionBuffer: FloatArray? = null

    // ========================================================================
    // AudioProcessor 接口实现
    // ========================================================================

    /**
     * 是否处于激活状态（已配置且可以处理数据）。
     */
    override fun isActive(): Boolean = true

    /**
     * 配置处理器。返回输出格式（与输入相同，不做重采样/编码转换）。
     */
    override fun configure(inputFormat: AudioProcessor.AudioFormat): AudioProcessor.AudioFormat {
        inputSampleRate = inputFormat.sampleRate
        inputChannelCount = inputFormat.channelCount
        inputEncoding = inputFormat.encoding
        Log.d(TAG, "Configured: ${inputSampleRate}Hz, ${inputChannelCount}ch, encoding=$inputEncoding")
        return inputFormat
    }

    /**
     * 输入 PCM 数据队列。
     *
     * 将传入的 ByteBuffer 转换为 DSPAudioProcessor 可处理的格式，
     * 处理后存储到 [pendingOutputBuffer] 供 [getOutput] 读取。
     * 必须将 inputBuffer.position 移至 limit，表示已消费所有输入。
     */
    override fun queueInput(inputBuffer: ByteBuffer) {
        val remaining = inputBuffer.remaining()
        if (remaining == 0) return

        inputBuffer.order(ByteOrder.LITTLE_ENDIAN)

        try {
            val processed = when (inputEncoding) {
                C.ENCODING_PCM_FLOAT -> {
                    // Float 格式：直接传递 ByteBuffer 给 processByteBuffer
                    dspProcessor.processByteBuffer(inputBuffer, inputChannelCount)
                }
                C.ENCODING_PCM_16BIT -> {
                    // 16-bit 格式：转换为 float → 处理 → 转换回 16-bit
                    process16BitBuffer(inputBuffer)
                }
                else -> {
                    // 不支持的编码：直通
                    Log.w(TAG, "Unsupported encoding: $inputEncoding, passthrough")
                    val passthrough = ByteBuffer.allocateDirect(remaining)
                    passthrough.order(ByteOrder.LITTLE_ENDIAN)
                    passthrough.put(inputBuffer)
                    passthrough.position(0)
                    passthrough
                }
            }

            // 标记输入已消费
            inputBuffer.position(inputBuffer.limit())

            // 设置待输出缓冲区
            pendingOutputBuffer = processed
            pendingOutputBuffer.order(ByteOrder.LITTLE_ENDIAN)
        } catch (e: Exception) {
            Log.e(TAG, "Error processing audio buffer", e)
            // 出错时直通
            inputBuffer.position(inputBuffer.limit())
            pendingOutputBuffer = inputBuffer
        }
    }

    /**
     * 获取处理后的输出缓冲区。
     *
     * 每次调用返回当前待输出缓冲区，之后重置为 EMPTY_BUFFER，
     * 表示无更多输出可用，直到下一次 [queueInput]。
     */
    override fun getOutput(): ByteBuffer {
        val output = if (pendingOutputBuffer.hasRemaining()) {
            pendingOutputBuffer
        } else {
            AudioProcessor.EMPTY_BUFFER
        }
        pendingOutputBuffer = AudioProcessor.EMPTY_BUFFER
        return output
    }

    /**
     * 标记输入流结束。调用后不再接收新数据，等待输出缓冲区消费完毕即结束。
     */
    override fun queueEndOfStream() {
        inputEnded = true
    }

    /**
     * 是否已结束（输入结束且输出已全部消费）。
     */
    override fun isEnded(): Boolean = inputEnded && !pendingOutputBuffer.hasRemaining()

    /**
     * 刷新内部状态。
     */
    override fun flush() {
        pendingOutputBuffer = AudioProcessor.EMPTY_BUFFER
        inputEnded = false
    }

    /**
     * 重置，释放资源。
     */
    override fun reset() {
        flush()
        conversionBuffer = null
        inputSampleRate = 44100
        inputChannelCount = 2
        inputEncoding = C.ENCODING_PCM_FLOAT
    }

    // ========================================================================
    // 内部方法
    // ========================================================================

    /**
     * 处理 16-bit PCM 缓冲区。
     *
     * 16-bit short → float (÷32768) → DSP 处理 → float → 16-bit short (×32768)
     */
    private fun process16BitBuffer(inputBuffer: ByteBuffer): ByteBuffer {
        val sampleCount = inputBuffer.remaining() / 2

        // 复用或分配转换缓冲区
        if (conversionBuffer == null || conversionBuffer!!.size < sampleCount) {
            conversionBuffer = FloatArray(sampleCount)
        }
        val floatBuffer = conversionBuffer!!

        // Short → Float (仅读取前 sampleCount 个 short)
        val shortView = inputBuffer.asShortBuffer()
        for (i in 0 until sampleCount) {
            floatBuffer[i] = shortView.get(i).toFloat() / 32768f
        }

        // DSP 处理（in-place）
        dspProcessor.process(floatBuffer, inputChannelCount)

        // Float → Short
        val outputBytes = sampleCount * 2
        val output = ByteBuffer.allocateDirect(outputBytes)
        output.order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until sampleCount) {
            val clamped = (floatBuffer[i] * 32768f)
                .toInt()
                .coerceIn(-32768, 32767)
            output.putShort(clamped.toShort())
        }
        output.position(0)
        return output
    }

    /**
     * 设置输入结束标志（外部调用，标记流结束）。
     */
    fun setInputEnded() {
        inputEnded = true
    }
}
