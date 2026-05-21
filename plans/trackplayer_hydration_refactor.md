# BiliMusic 后台播放架构终极重构方案 (Queue Hydration)

## 1. 核心痛点与架构目标

### 1.1 当前架构的致命缺陷 (Lazy Resolve / Placeholder Queue)
当前架构在原生播放队列中放入了 `placeholder://` 或 `silence.wav` 占位符，依赖 JS 线程在切歌瞬间（`skipToNext`）去异步请求 B 站 API 获取真实 URL。
在 Android 系统中，当应用处于后台且音频暂停时，系统会进入 Doze 模式或 App Standby，**严格限制 JS 线程的网络访问**。
这导致：
1.  **锁屏切歌卡死**：网络请求被系统挂起，Mutex 锁死，UI 无响应。
2.  **Foreground Service 崩溃**：如果占位符进入 ExoPlayer，会触发 `PlaybackError`，导致前台服务被系统回收。
3.  **连点爆炸**：切回前台后，积压的请求瞬间释放，导致疯狂切歌。

### 1.2 终极架构目标 (Spotify / YouTube Music 工业级标准)
**核心原则：播放队列进入 Native (ExoPlayer) 之前，必须 100% 可播放化 (Hydrated Queue)。**
*   **彻底废除占位符**：原生队列中只允许存在真实的、可立即播放的 HTTP URL 或本地 File URL。
*   **JS 退出播放关键路径**：切歌操作 (`skipToNext` / `skipToPrevious`) 必须是纯原生的、同步的，不允许触发任何 JS 异步网络请求。
*   **提前水合 (Pre-Hydration)**：在用户点击播放列表（`loadQueue`）时，或者在当前歌曲播放时（网络畅通），提前解析好后续歌曲的真实 URL 并注入原生队列。

---

## 2. 详细改造步骤

### 2.1 彻底删除 Placeholder 相关逻辑
*   **删除 `buildPlaceholderTrack`**：不再生成任何 `placeholder://` 或 `silence.wav` 轨道。
*   **删除 `lazyResolve`**：废除按需解析的核心函数。
*   **清理事件监听器**：
    *   `RemoteNext` / `RemotePrevious`：恢复为最简单的 `TrackPlayer.skipToNext()` 和 `TrackPlayer.skipToPrevious()`。删除所有 Mutex 锁和手动接管逻辑。
    *   `PlaybackActiveTrackChanged`：删除所有关于占位符判断、陈旧事件拦截、以及触发 `lazyResolve` 的逻辑。只保留状态同步（`setCurrentBvid`）和纯数据预取（`prefetchNextTracks`）。
    *   `PlaybackError`：删除所有关于占位符补解析的抢救逻辑。回归本职：只处理真正的网络断开或 URL 失效。

### 2.2 重构 `loadQueue` (Batch Hydration)
当用户点击播放列表中的某首歌时，不能再把整个列表的占位符塞进原生队列。
**新策略：只加载当前首 + 预加载窗口内的歌曲（例如后 2 首），且必须是真实 URL。**

```typescript
// 伪代码示例
export async function loadQueue(videos: FavoriteVideo[], startBvid?: string) {
  // 1. 确定起始索引
  const startIndex = ...;
  
  // 2. 截取滑动窗口 (例如：当前首 + 后 2 首)
  const windowVideos = videos.slice(startIndex, startIndex + 3);
  
  // 3. 批量解析真实 URL (Batch Hydration)
  // 注意：这里需要并发请求 API，或者修改 audioService 支持批量获取
  const hydratedTracks = await Promise.all(windowVideos.map(async (v) => {
     const info = await audioService.getInfo(v.bvid, quality);
     return {
       id: v.bvid,
       url: info.audio.baseUrl,
       userAgent: config.userAgent,
       headers: { Referer: config.referer, 'User-Agent': config.userAgent },
       // ... 其他 metadata
     };
  }));
  
  // 4. 注入原生队列并播放
  await TrackPlayer.reset();
  await TrackPlayer.add(hydratedTracks);
  await TrackPlayer.play();
  
  // 5. 更新 Zustand Store (Logical Queue 保持全量，Native Queue 是滑动窗口)
  usePlayerStore.getState().setQueue(videos, startBvid);
}
```

### 2.3 实现动态滑动窗口 (Dynamic Queue Hydration)
由于 B 站 API 的 URL 有时效性（通常几小时），且一次性解析几百首歌会触发风控（Rate Limit），我们不能把整个播放列表都解析完塞进原生队列。
**必须维护一个“逻辑队列 (Zustand)”和“原生队列 (TrackPlayer)”的映射关系。**

在 `PlaybackActiveTrackChanged` 事件中，动态维护原生队列：
1.  **预解析下一首**：当播放到原生队列的倒数第二首时，从逻辑队列中取出下一首歌，解析真实 URL，并 `TrackPlayer.add()` 到原生队列尾部。
2.  **清理已播放**：为了防止原生队列无限增长导致内存溢出，可以适时 `TrackPlayer.remove()` 已经播放过的、距离当前较远的轨道。

```typescript
// 伪代码示例 (在 PlaybackActiveTrackChanged 中)
TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async (e) => {
  const activeIndex = await TrackPlayer.getActiveTrackIndex();
  const nativeQueue = await TrackPlayer.getQueue();
  
  // 如果快播到原生队列末尾了 (例如只剩 1 首)
  if (activeIndex >= nativeQueue.length - 2) {
     // 1. 从 Zustand 逻辑队列中找到下一首需要播放的视频
     const logicalQueue = usePlayerStore.getState().queue;
     const currentBvid = nativeQueue[activeIndex].id;
     const logicalIndex = logicalQueue.findIndex(v => v.bvid === currentBvid);
     
     const nextVideo = logicalQueue[logicalIndex + 1];
     if (nextVideo) {
        // 2. 解析真实 URL
        const info = await audioService.getInfo(nextVideo.bvid, quality);
        const realTrack = { ... }; // 构建真实轨道
        
        // 3. 追加到原生队列
        await TrackPlayer.add(realTrack);
     }
  }
});
```

### 2.4 优化 `playSpecificPart` 和 `reorderQueue`
*   **`playSpecificPart`**：直接解析目标分 P 的真实 URL，然后 `TrackPlayer.add()` 并 `skip()`。
*   **`reorderQueue`**：由于原生队列现在只包含滑动窗口内的真实轨道，重排逻辑需要基于 Zustand 的逻辑队列进行，并重新计算和水合当前窗口。

### 2.5 确保 Foreground Service 行为
在 `setupPlayer` 中，确保 `appKilledPlaybackBehavior` 设置正确，允许后台持续播放。
```typescript
await TrackPlayer.updateOptions({
  android: {
    appKilledPlaybackBehavior: AppKilledPlaybackBehavior.ContinuePlayback, // 或 StopPlaybackAndRemoveNotification，取决于业务需求
  },
  // ...
});
```

---

## 3. 实施计划 (Todo List)

1.  [ ] **清理旧代码**：移除 `trackPlayer.ts` 中所有关于 `placeholder`、`lazyResolve`、`skipMutex` 的代码。
2.  [ ] **重构 `loadQueue`**：实现初始的 Batch Hydration，只加载当前首和后续少量轨道（真实 URL）。
3.  [ ] **实现动态滑动窗口**：在 `PlaybackActiveTrackChanged` 中添加逻辑，提前解析并 `add` 后续轨道，确保原生队列始终有真实 URL 储备。
4.  [ ] **重构切歌事件**：将 `RemoteNext` / `RemotePrevious` 恢复为极简的 `skipToNext()` / `skipToPrevious()`。
5.  [ ] **适配其他队列操作**：重构 `playSpecificPart`、`reorderQueue`、`appendQueue` 等方法，使其适应新的“逻辑队列 + 原生滑动窗口”架构。
6.  [ ] **测试验证**：重点测试锁屏状态下的连续切歌、断网恢复、以及长列表播放的内存占用。