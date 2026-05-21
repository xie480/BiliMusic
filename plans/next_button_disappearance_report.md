# 锁屏/通知栏“下一首”按钮消失问题排查报告

## 1. 现象复现与确认
用户反馈：在应用后台播放时，通过锁屏或通知栏的 Android 原生播放器 UI 进行切歌，仍然会出现“下一首”按钮消失的情况（整个播放器 UI 未消失，仅按钮消失）。

## 2. 根因分析：为什么按钮依然会消失？

你猜测的非常准确：“**是不是预加载的原因，播放队列中只有预加载的歌曲，然后预加载只触发了一次，导致播放队列歌曲都播放完了，所以按钮消失了？**”

经过对重构后代码的深入排查，确实是这个原因，并且还隐藏着一个更深层的逻辑漏洞。

### 漏洞一：`maintainQueueBuffer` 的触发条件失效
在 `src/services/trackPlayer.ts` 中，我们设计了 `maintainQueueBuffer` 来维持原生队列的长度：
```typescript
async function maintainQueueBuffer() {
  // ...
  const remaining = nativeQueue.length - 1 - activeIndex;
  if (remaining < 3) {
    // 触发水合
  }
}
```
**问题在于：当用户在锁屏快速连续点击“下一首”时，`activeIndex` 会迅速增加，导致 `remaining` 迅速减小并触发水合。但是，水合是一个极其耗时的网络请求（可能长达 20 秒）。**

在水合完成之前，如果用户继续点击“下一首”，或者当前歌曲播放完毕自动进入下一首，`activeIndex` 会继续增加，直到 `activeIndex === nativeQueue.length - 1`。
此时，原生队列中**确实没有下一首歌了**。Android MediaSession 发现队列到底了，就会无情地隐藏“下一首”按钮。

### 漏洞二：`hydrateNextTracks` 的并发冲突（核心致命点）
当 `remaining < 3` 时，会触发 `hydrateNextTracks`。
如果用户连续切歌，`PlaybackActiveTrackChanged` 会被连续触发多次，从而导致 `maintainQueueBuffer` 被并发调用多次。
```typescript
// 连续切歌导致并发调用
maintainQueueBuffer() -> hydrateNextTracks(index: 5) // 耗时 10s
maintainQueueBuffer() -> hydrateNextTracks(index: 6) // 耗时 10s
```
这会导致：
1. **重复水合**：相同的歌曲被多次请求，加剧了 B 站 API 的频控（412 错误），导致网络请求更慢。
2. **乱序添加**：由于网络响应时间不确定，后请求的歌曲可能先返回并被 `TrackPlayer.add()`，导致原生队列顺序错乱，MediaSession 彻底崩溃。

### 漏洞三：极简切歌逻辑的副作用
```typescript
TrackPlayer.addEventListener(Event.RemoteNext, async () => {
  await TrackPlayer.skipToNext().catch(() => {});
  await TrackPlayer.play().catch(() => {});
});
```
如果原生队列已经到底（没有下一首），`skipToNext()` 会直接抛出错误（被 catch 吞掉），播放器状态可能变为 Stopped。此时 UI 上的按钮自然就消失了。

## 3. 为什么之前的“占位符(Placeholder)”方案能保住按钮？
在重构前，虽然代码很乱，但它有一个特性：**它会在原生队列中塞入未解析的假 URL 或占位符**。
因为原生队列里始终有东西（哪怕是假的），Android 系统就认为“后面还有歌”，所以按钮不会消失。
但我们为了追求“工业级”的 Append-only 真实 URL 队列，去掉了占位符，这就要求我们的**后台水合速度必须永远快于用户的切歌速度**，这在弱网或 API 频控下是不可能实现的。

## 4. 最终修复方案：结合工业级架构与占位符保底

为了在“不破坏 MediaSession 稳定性”和“应对极端网络延迟”之间取得平衡，我们必须引入**“静音占位符 (Silence Placeholder)”**机制，并结合互斥锁防止并发水合。

### 修复步骤：

1. **引入互斥锁 (Mutex)**：
   防止 `maintainQueueBuffer` 被并发执行。同一时间只能有一个水合任务在跑。
2. **使用静音音频占位**：
   当 `loadQueue` 或 `maintainQueueBuffer` 发现后续歌曲尚未解析时，**先向原生队列中 `add` 一个本地的静音音频（如 `resource/silence_10s.wav`）作为占位符**。
   - 这样原生队列永远是满的，Android 的“下一首”按钮永远不会消失。
3. **拦截占位符播放**：
   在 `PlaybackActiveTrackChanged` 中，如果发现当前播放的是占位符音频：
   - 立即暂停播放（显示 Loading）。
   - 等待真实 URL 水合完成。
   - 使用真实 URL 替换（或跳过）占位符，然后恢复播放。

## 5. 结论
你观察到的现象完全正确。纯粹的“真实 URL 预加载”在面对网络延迟和用户快速切歌时，必然会导致原生队列被“掏空”，从而触发 Android 系统的 UI 隐藏机制。

**必须采用：Append-only 真实轨道 + 本地静音占位轨道 + 并发锁控制**，才能打造出真正无懈可击的后台播放体验。

我已将此报告输出，接下来我们可以切换回 Code 模式，实施最终的占位符修复方案。