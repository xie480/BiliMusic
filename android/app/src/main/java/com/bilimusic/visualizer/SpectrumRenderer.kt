package com.bilimusic.visualizer

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.*
import kotlin.concurrent.Volatile

/**
 * OpenGL ES 2.0 频谱渲染器 — 增强版
 *
 * 核心优化：
 * 1. **非对称动画平滑**：上升快速跟踪瞬态，下降带重力加速度衰减，
 *    产生自然"弹跳"物理感，消除生硬跳变。
 * 2. **垂直渐变渲染**：每个柱状条从底到顶颜色渐变 + 透明度衰减，
 *    底部饱和明亮，顶部透明消散，营造通透层次感。
 * 3. **顶部视觉安全区**：限制最大高度占比，为峰值预留"呼吸"空间，
 *    消除平顶/满量程驻留现象。
 * 4. **升级 OpenGL Shader**：Vertex Shader 传递顶点渐变因子，
 *    Fragment Shader 混合底部/顶部颜色，支持逐顶点颜色插值。
 *
 * 渲染内容：
 * 1. 双层柱状频谱 + 垂直渐变 Glow 发光
 * 2. 细线波形（高频细节）— 点阵连接
 * 3. 猫耳动态频谱（左右声道高频映射）
 * 4. 呼吸流光和发光效果
 *
 * 配色：蓝紫霓虹 (#6C5CE7 ~ #A855F7)
 */
class SpectrumRenderer : GLSurfaceView.Renderer {

    // ====== 频谱数据（由 FFT Analyzer 更新） ======
    @Volatile
    var spectrumData = FloatArray(512)

    @Volatile
    var catEarLeft = FloatArray(16)

    @Volatile
    var catEarRight = FloatArray(16)

    // ====== 动画状态 ======
    private var peakHold = FloatArray(512)      // 峰值保持（余晖效果）
    private var smoothData = FloatArray(512)    // 非对称平滑数据

    // ====== 非对称平滑参数 ======
    private val attackFactor = 0.35f            // 上升速度：快速响应瞬态
    private val releaseBase = 0.06f             // 下降基速：慢速衰减
    private val gravityStrength = 0.18f         // 重力强度：高度越高下落越快

    // ====== 峰值保持参数 ======
    private val peakAttackFactor = 0.50f        // 峰值上升速度
    private val peakDecayFactor = 0.955f        // 峰值保持衰减率

    // ====== 视觉安全区 ======
    private val safeZoneHeight = 0.8f          // 柱状条最大占视口高度比例
    private val baseOffset = 0.12f              // 底部偏移比例

    // ====== 呼吸流光相位 ======
    private var breathPhase = 0f

    // ====== OpenGL 资源 ======
    private var program = 0
    private var positionHandle = 0
    private var bottomColorHandle = 0
    private var topColorHandle = 0
    private var uResolution = 0

    // 视口尺寸
    private var viewWidth = 1080f
    private var viewHeight = 400f

    // 顶点步长：每个顶点 3 个 float (x, y, gradient_t)
    private val STRIDE = 3 * 4 // 12 bytes

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 0f) // 透明背景

        // 创建着色器程序
        val vertexShader = loadShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
        val fragmentShader = loadShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertexShader)
        GLES20.glAttachShader(program, fragmentShader)
        GLES20.glLinkProgram(program)

        // 获取 attribute/uniform 位置
        positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
        bottomColorHandle = GLES20.glGetUniformLocation(program, "uBottomColor")
        topColorHandle = GLES20.glGetUniformLocation(program, "uTopColor")
        uResolution = GLES20.glGetUniformLocation(program, "uResolution")

        GLES20.glEnable(GLES20.GL_BLEND)
        GLES20.glBlendFunc(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        viewWidth = width.toFloat()
        viewHeight = height.toFloat()
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        GLES20.glUseProgram(program)

        // 传递分辨率
        GLES20.glUniform2f(uResolution, viewWidth, viewHeight)

        // 更新呼吸相位
        breathPhase = (breathPhase + 0.02f) % (2f * PI).toFloat()

        // 频谱柱状条（主视觉层）
        drawSpectrumBars()

        // 细线波形（高频细节层）
        drawWaveform()

        // 猫耳频谱
        drawCatEars()
    }

    /**
     * 绘制频谱柱状条（第一层）— 增强版
     *
     * 优化内容：
     * - 非对称 EMA 平滑 + 重力衰减
     * - 峰值保持余晖
     * - 垂直渐变渲染（底部→顶部 颜色+透明度渐变）
     * - 顶部安全区预留
     */
    private fun drawSpectrumBars() {
        val barCount = min(spectrumData.size, 48)
        if (barCount == 0) return

        val totalWidth = viewWidth
        val barWidth = totalWidth / barCount.toFloat() * 0.70f
        val gap = totalWidth / barCount.toFloat() * 0.30f

        // 底部 Y 位置 + 安全预留
        val baseY = viewHeight * baseOffset
        val maxBarHeight = viewHeight * safeZoneHeight

        for (i in 0 until barCount) {
            // ======================
            // 1. 非对称平滑 + 重力衰减
            // ======================
            val currentVal = if (i < spectrumData.size) spectrumData[i] else 0f

            if (currentVal > smoothData[i]) {
                // 上升：快速跟踪（攻击阶段）
                smoothData[i] = smoothData[i] * (1f - attackFactor) + currentVal * attackFactor
            } else {
                // 下降：重力加速度衰减
                // 高度越高，下落越快（模拟重力 pulling）
                // 接近底部时下落变慢（模拟空气阻力 / 阻尼）
                val normalizedHeight = smoothData[i] // 0~1
                val gravityBoost = gravityStrength * (normalizedHeight * normalizedHeight)
                val effectiveRelease = (releaseBase + gravityBoost).coerceIn(0.05f, 0.45f)
                smoothData[i] = smoothData[i] * (1f - effectiveRelease) + currentVal * effectiveRelease
            }

            // ======================
            // 2. 峰值保持（余晖指示）
            // ======================
            if (smoothData[i] > peakHold[i]) {
                peakHold[i] = smoothData[i] * peakAttackFactor + peakHold[i] * (1f - peakAttackFactor)
            } else {
                peakHold[i] *= peakDecayFactor
            }

            // ======================
            // 3. 计算位置与尺寸
            // ======================
            // 应用平滑数据
            val barValue = smoothData[i].coerceIn(0f, 1f)
            val barHeight = barValue * maxBarHeight
            val x = i * (barWidth + gap) + gap / 2f
            val topY = baseY + barHeight

            // ======================
            // 4. 呼吸流光强度 （每根柱子有独立的相位偏移）
            // ======================
            val glowIntensity = 0.55f + 0.45f * sin(breathPhase + i * 0.25f).coerceIn(0f, 1f)

            // ======================
            // 5. 颜色计算：蓝紫霓虹渐变
            // ======================
            // 底部颜色：饱和明亮，随能量变化色相 (蓝→紫)
            val hue = 245f - smoothData[i] * 50f // 245(蓝紫) ~ 195(紫青)
            val bottomR = (sin((hue + 100f) * PI / 180f) * 0.5f + 0.35f).toFloat()
            val bottomG = (sin((hue + 220f) * PI / 180f) * 0.5f + 0.25f).toFloat()
            val bottomB = 0.95f
            val bottomA = (0.75f + smoothData[i] * 0.25f).coerceIn(0f, 1f)

            // 顶部颜色：浅色透明，趋于消散
            val topR = bottomR * 0.5f
            val topG = bottomG * 0.6f
            val topB = 0.85f
            // 顶部透明度随能量和高度衰减：能量越低越透明，且顶部本身就要淡出
            val topA = (0.15f + smoothData[i] * 0.25f).coerceIn(0f, 0.4f)

            // 发光强度叠加
            val glowMod = glowIntensity * (0.7f + 0.3f * smoothData[i])
            val bottomColor = floatArrayOf(
                (bottomR * glowMod).coerceIn(0f, 1f),
                (bottomG * glowMod).coerceIn(0f, 1f),
                (bottomB * glowMod).coerceIn(0f, 1f),
                bottomA
            )
            val topColor = floatArrayOf(
                (topR * glowMod).coerceIn(0f, 1f),
                (topG * glowMod).coerceIn(0f, 1f),
                (topB * glowMod).coerceIn(0f, 1f),
                topA
            )

            // 绘制圆角柱状条（带垂直渐变）
            drawBar(x, baseY, barWidth, barHeight, bottomColor, topColor)
        }
    }

    /**
     * 绘制高频细节波形（第二层）
     */
    private fun drawWaveform() {
        val pointCount = min(spectrumData.size, 64)
        if (pointCount < 2) return

        val stepX = viewWidth / pointCount.toFloat()
        val baseY = viewHeight * 0.5f

        // 从频谱中段开始取高频部分
        val startIdx = spectrumData.size / 3

        // 顶点格式 (x, y, gradient_t)
        val vertices = FloatArray(pointCount * 3)
        for (i in 0 until pointCount) {
            val idx = startIdx + i * (spectrumData.size - startIdx) / pointCount
            val value = if (idx < spectrumData.size) spectrumData[idx] else 0f
            vertices[i * 3] = i * stepX
            vertices[i * 3 + 1] = baseY + (value - 0.5f) * viewHeight * 0.3f
            vertices[i * 3 + 2] = 0.5f // 中值渐变（颜色取中间值）
        }

        val vertexBuffer = ByteBuffer
            .allocateDirect(vertices.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
            .put(vertices)
        vertexBuffer.position(0)

        // 波形线使用一致的半透亮青色
        GLES20.glUniform4f(bottomColorHandle, 0.3f, 0.7f, 1.0f, 0.5f)
        GLES20.glUniform4f(topColorHandle, 0.3f, 0.7f, 1.0f, 0.5f)

        GLES20.glVertexAttribPointer(
            positionHandle, 3, GLES20.GL_FLOAT, false, STRIDE, vertexBuffer
        )
        GLES20.glEnableVertexAttribArray(positionHandle)
        GLES20.glLineWidth(2f)
        GLES20.glDrawArrays(GLES20.GL_LINE_STRIP, 0, pointCount)
        GLES20.glDisableVertexAttribArray(positionHandle)
    }

    /**
     * 绘制猫耳动态频谱
     *
     * 左右各一只猫耳，由高频能量驱动
     */
    private fun drawCatEars() {
        val earCount = min(catEarLeft.size, 16)

        // 左耳
        drawSingleEar(catEarLeft, earCount, viewWidth * 0.3f, false)
        // 右耳
        drawSingleEar(catEarRight, earCount, viewWidth * 0.7f, true)
    }

    private fun drawSingleEar(data: FloatArray, count: Int, centerX: Float, flipped: Boolean) {
        val earWidth = 60f
        val earHeight = 80f
        val direction = if (flipped) -1f else 1f

        // 猫耳由多个三角形组成，使用高频数据驱动耳尖高度
        val segmentCount = count / 2
        val segmentWidth = earWidth / segmentCount

        for (i in 0 until segmentCount) {
            val leftIdx = i
            val rightIdx = count - 1 - i

            val leftVal = data[leftIdx].coerceIn(0f, 1f)
            val rightVal = data[rightIdx].coerceIn(0f, 1f)

            // 耳尖高度 = 平均值 * 最大高度
            val tipHeight = ((leftVal + rightVal) / 2f) * earHeight

            // 猫耳形状：底部宽，顶部尖
            val bottomY = viewHeight * 0.5f
            val tipX = centerX
            val tipY = bottomY - tipHeight
            val baseLeftX = centerX - segmentWidth * (segmentCount - i) * direction
            val baseRightX = centerX - segmentWidth * (segmentCount - 1 - i) * direction
            val baseY = bottomY

            // 顶点格式 (x, y, gradient_t) — 猫耳不需要垂直渐变，gradient_t = 0
            val vertices = floatArrayOf(
                tipX, tipY, 0f,
                baseLeftX, baseY, 0f,
                baseRightX, baseY, 0f
            )

            val vertexBuffer = ByteBuffer
                .allocateDirect(vertices.size * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
                .put(vertices)
            vertexBuffer.position(0)

            // 颜色：根据能量渐变，峰值时发光
            val energy = (leftVal + rightVal) / 2f
            val r = (0.4f + energy * 0.6f)
            val g = (0.3f + energy * 0.5f)
            val b = 0.8f + energy * 0.2f
            val alpha = 0.5f + energy * 0.5f

            GLES20.glUniform4f(bottomColorHandle, r, g, b, alpha)
            GLES20.glUniform4f(topColorHandle, r, g, b, alpha)
            GLES20.glVertexAttribPointer(
                positionHandle, 3, GLES20.GL_FLOAT, false, STRIDE, vertexBuffer
            )
            GLES20.glEnableVertexAttribArray(positionHandle)
            GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3)
            GLES20.glDisableVertexAttribArray(positionHandle)
        }
    }

    /**
     * 绘制单个柱状条（圆角矩形 + 垂直渐变）
     *
     * 使用 6 个三角形构建圆角矩形，每个顶点携带渐变因子：
     * - 底部顶点 gradient_t = 0 → 使用 uBottomColor
     * - 顶部顶点 gradient_t = 1 → 使用 uTopColor
     * - Shader 自动在片段着色器中进行线性插值
     *
     * @param x 左下角 X
     * @param y 左下角 Y（底部）
     * @param width 宽度
     * @param height 高度
     * @param bottomColor 底部颜色 (RGBA)
     * @param topColor 顶部颜色 (RGBA)
     */
    private fun drawBar(
        x: Float, y: Float, width: Float, height: Float,
        bottomColor: FloatArray, topColor: FloatArray
    ) {
        if (height < 0.5f) return // 太短则不绘制

        val radius = min(width / 2f, 4f)
        val topY = y + height

        // 顶点格式：每个顶点 3 个 float (x, y, gradient_t)
        // gradient_t: 0 = 底部颜色, 1 = 顶部颜色
        val vertices = floatArrayOf(
            // ---- 主体矩形（2 个三角形，4 个顶点） ----
            // 三角形 1
            x + radius, y, 0f,
            x + width - radius, y, 0f,
            x + radius, topY, 1f,
            // 三角形 2
            x + width - radius, y, 0f,
            x + width - radius, topY, 1f,
            x + radius, topY, 1f,

            // ---- 顶部半圆（两个三角形近似圆角） ----
            // 顶部左侧圆角
            x, topY - radius, 1f,
            x + radius, topY, 1f,
            x + radius, topY - radius, 1f,
            // 顶部右侧圆角
            x, topY - radius, 1f,
            x + radius, topY, 1f,
            x, topY, 1f,
        )

        val vertexBuffer = ByteBuffer
            .allocateDirect(vertices.size * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()
            .put(vertices)
        vertexBuffer.position(0)

        // 设置渐变颜色
        GLES20.glUniform4f(
            bottomColorHandle,
            bottomColor[0], bottomColor[1], bottomColor[2], bottomColor[3]
        )
        GLES20.glUniform4f(
            topColorHandle,
            topColor[0], topColor[1], topColor[2], topColor[3]
        )

        GLES20.glVertexAttribPointer(
            positionHandle, 3, GLES20.GL_FLOAT, false, STRIDE, vertexBuffer
        )
        GLES20.glEnableVertexAttribArray(positionHandle)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, vertices.size / 3)
        GLES20.glDisableVertexAttribArray(positionHandle)
    }

    // ====== 着色器 ======

    companion object {
        /**
         * Vertex Shader
         *
         * 接收 aPosition(x, y, gradient_t)，传递 vGradT 到 Fragment Shader
         * 用于垂直渐变插值。
         */
        private const val VERTEX_SHADER = """
            attribute vec4 aPosition;
            varying float vGradT;
            void main() {
                gl_Position = vec4(aPosition.xy / vec2(540.0, 200.0) - 1.0, 0.0, 1.0);
                vGradT = aPosition.z;
            }
        """

        /**
         * Fragment Shader
         *
         * 接收 uBottomColor 和 uTopColor，根据 vGradT 在两者间线性插值。
         * vGradT = 0 → uBottomColor (底部，饱和明亮)
         * vGradT = 1 → uTopColor (顶部，透明消散)
         */
        private const val FRAGMENT_SHADER = """
            precision mediump float;
            uniform vec4 uBottomColor;
            uniform vec4 uTopColor;
            varying float vGradT;
            void main() {
                gl_FragColor = mix(uBottomColor, uTopColor, vGradT);
            }
        """

        fun loadShader(type: Int, source: String): Int {
            val shader = GLES20.glCreateShader(type)
            GLES20.glShaderSource(shader, source)
            GLES20.glCompileShader(shader)
            return shader
        }
    }
}
