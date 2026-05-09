# ========== React Native 默认 ==========
-keep,allowobfuscation @interface com.facebook.proguard.annotations.DoNotStrip
-keep,allowobfuscation @interface com.facebook.proguard.annotations.KeepGettersAndSetters
-keep,allowobfuscation @interface com.facebook.common.internal.DoNotStrip

-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keep @com.facebook.common.internal.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
    @com.facebook.common.internal.DoNotStrip *;
}

-keep class com.facebook.react.bridge.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# ========== 第三方依赖 ===========

# react-native-track-player & ExoPlayer
-keep class com.doublesymmetry.trackplayer.** { *; }
-keep class com.google.android.exoplayer2.** { *; }
-dontwarn com.google.android.exoplayer2.**

# react-native-fs
-keep class com.rnfs.** { *; }

# MMKV
-keep class com.tencent.mmkv.** { *; }

# react-native-fast-image
-keep public class com.dylanvann.fastimage.* { *; }
-keep public class com.dylanvann.fastimage.** { *; }
-keep public class * implements com.bumptech.glide.module.GlideModule
-keep public class * extends com.bumptech.glide.module.AppGlideModule
-keep public enum com.bumptech.glide.load.ImageHeaderParser$** { **[] $VALUES; public *; }

# react-native-vector-icons
-keep class com.oblador.vectoricons.** { *; }

# NetInfo
-keep class com.reactnativecommunity.netinfo.** { *; }

# OkHttp / Axios 底层
-dontwarn okhttp3.**
-dontwarn okio.**

# 反射通用
-keepattributes *Annotation*
-keepattributes Signature
-keepattributes Exceptions
-keepattributes EnclosingMethod
-keepattributes InnerClasses

# ========== 自定义音频 DSP 与频谱反射保护 ==========
# 保护 DSPAudioProcessor 和 EqAudioProcessorAdapter 不被混淆，
# 因为在 MusicService 中使用了反射调用（Class.forName）
-keep class com.bilimusic.audio.** { *; }
-keep class com.bilimusic.module.** { *; }
-keep class com.bilimusic.visualizer.** { *; }

# 保护 kotlin-audio 中的 BaseAudioPlayer，
# 因为 patch 中反射调用了它的 getExoPlayer 方法
-keep class com.doublesymmetry.kotlinaudio.** { *; }
