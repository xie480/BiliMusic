# 工业级音频队列架构重构方案 (Spotify/YouTube Music 级)

## 🚨 背景与根因分析

当前在后台播放时，锁屏或通知栏的“下一首”按钮会消失。根本原因并非单纯的网络延迟，而是 **MediaSession timeline 在 runtime 被“重建”**。

当执行 `hydrateNextTracks()` 时，如果发生阻塞等待（如 API 频控导致耗时 20s+），原生队列（Native Queue）可能被耗尽。更致命的是，频繁的 `add`/`remove` 或 `reset` 操作会导致 Android MediaSession 重新同步。一旦 Android 系统判定 queue invalid（例如短暂为空，或 index 发生偏移），UI 就会直接重建 action bar，导致 next/prev 按钮消失。

## 🧠 核心架构原则 (三条铁律)

为了彻底解决此问题，必须将 MediaSession Queue 改为：**Append-only + Always-buffered + Native-owned**。

1. **Queue 绝对禁止 Shrink / Reset / Rebuild**：MediaSession queue 一旦建立，在正常播放和切歌过程中只能“加”（Append），不能“改”或“清空”。
2. **Hydration 必须脱离 Playback 主链路**：水合（获取真实 URL）必须是后台异步的（Background Worker），绝对不能阻塞播放或切歌操作。
3. **Native Queue 永远保持充足的 Buffer**：原生队列必须永远保持 `当前播放 + 后续 N 首`（建议 N ≥ 3），确保 MediaSession 永远不会 transiently empty。

## 🧱 三层架构设计

1. **Logical Queue (React Native 层)**
   - 仅维护 `trackId` (bvid/cid) 列表。
   - 负责 UI 展示和逻辑顺序，**绝不直接触碰播放控制**。
2. **Hydration Cache / Worker (JS/Native 异步层)**
   - 负责监听 Logical Queue 和当前播放进度。
   - 提前预解析（Prefetch）后续 3-5 首歌的真实 URL 并缓存。
   - 完全异步，Fire-and-forget。
3. **Native Playback Queue (ExoPlayer / TrackPlayer 层)**
   - 仅包含已完全解析（Fully Hydrated）的真实 URL MediaItems。
   - **Append-only**：只通过 `TrackPlayer.add()` 追加，不使用 `remove` 或 `reset`（除非用户主动切换了全新的歌单）。

## 🚀 详细实施步骤

### 步骤 1：重构初始化加载逻辑 (`loadQueue`)
**目标**：初始化时一次性加载足够多的已水合轨道，建立稳定的初始 Timeline。
- **动作**：当用户点击播放某首歌时，获取该歌及后续 3-4 首歌。
- **逻辑**：
  ```typescript
  // 伪代码
  async function loadQueue(videos, startIndex) {
    // 1. 获取初始窗口 (例如 5 首歌)
    const initialWindow = videos.slice(startIndex, startIndex + 5);
    // 2. 并发水合这 5 首歌
    const hydratedTracks = await Promise.all(initialWindow.map(v => hydrateVideo(v)));
    // 3. 建立原生队列 (这是唯一允许 reset 的地方，因为是全新的播放上下文)
    await TrackPlayer.reset();
    await TrackPlayer.add(hydratedTracks.flat());
    await TrackPlayer.play();
    // 4. 触发后台 Worker 继续水合后续
    triggerBackgroundHydration(videos, startIndex + 5);
  }
  ```

### 步骤 2：实现后台异步水合 Worker
**目标**：将 `hydrateNextTracks` 从阻塞调用改为纯后台任务。
- **动作**：创建一个独立的水合维护函数，确保原生队列始终有足够的 buffer。
- **逻辑**：
  ```typescript
  // 伪代码
  async function maintainQueueBuffer() {
    const logicalQueue = usePlayerStore.getState().queue;
    const nativeQueue = await TrackPlayer.getQueue();
    const activeIndex = await TrackPlayer.getActiveTrackIndex();
    
    // 计算原生队列中剩余的未播放歌曲数
    const remaining = nativeQueue.length - 1 - activeIndex;
    
    if (remaining < 3) {
      // 异步触发，不 await
      hydrateAndAppendNext(logicalQueue, nativeQueue.length).catch(console.error);
    }
  }
  
  async function hydrateAndAppendNext(logicalQueue, startLogicalIndex) {
    // 获取下 N 首
    const tracksToHydrate = logicalQueue.slice(startLogicalIndex, startLogicalIndex + 3);
    for (const video of tracksToHydrate) {
      const tracks = await hydrateVideo(video); // 耗时操作
      if (tracks.length > 0) {
        await TrackPlayer.add(tracks); // Append-only
      }
    }
  }
  ```

### 步骤 3：重构播放状态监听 (`PlaybackActiveTrackChanged`)
**目标**：在切歌时，仅触发后台水合，绝不阻塞。
- **动作**：移除原有的阻塞式水合逻辑。
- **逻辑**：
  ```typescript
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (e) => {
    // ... 更新 UI 状态 ...
    
    // 触发后台水合检查 (Fire-and-forget)
    maintainQueueBuffer().catch(() => {});
  });
  ```

### 步骤 4：彻底简化 Skip 逻辑
**目标**：移除所有为了等待水合而做的拦截和占位逻辑。
- **动作**：删除 `Event.RemoteNext` 和 `Event.RemotePrevious` 中的复杂拦截。
- **逻辑**：
  ```typescript
  // 极简切歌，完全信任 Native Queue
  TrackPlayer.addEventListener(Event.RemoteNext, () => TrackPlayer.skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => TrackPlayer.skipToPrevious());
  ```

### 步骤 5：处理队列变更 (Insert/Remove/Reorder)
**目标**：在不破坏 MediaSession 的前提下处理逻辑队列的变更。
- **Insert Next**：水合新歌后，使用 `TrackPlayer.add(track, activeIndex + 1)` 插入。
- **Remove**：如果必须移除，尽量只在 Logical Queue 中标记。如果必须从 Native Queue 移除，确保不要移除当前正在播放或即将播放（+1）的轨道，以防 MediaSession 震荡。
- **Reorder**：如果用户大幅重排了未播放的歌曲，可以清空当前播放之后的 Native Queue，然后重新触发 `maintainQueueBuffer()` 进行 Append。

## 🎯 预期效果
1. **Next 按钮永不消失**：因为 Native Queue 永远有真实的后续轨道，MediaSession 始终稳定。
2. **切歌零延迟**：用户点击下一首时，直接播放 Native Queue 中已缓存的真实 URL，无需等待网络请求。
3. **网络容错极高**：即使 B 站 API 频控导致水合耗时 20 秒，也只是后台默默重试，完全不影响当前歌曲的播放和 UI 的稳定性。