# 工业级音频队列架构重构方案 (最终稳定版)

## 🚨 背景与目标

当前在后台播放时，锁屏或通知栏的“下一首”按钮会消失。根本原因在于：
1. **Native Queue 被掏空**：预加载数量太少（仅 3 首），用户快速切歌或网络延迟时，原生队列到底，Android MediaSession 判定无下一首，隐藏按钮。
2. **并发水合冲突**：连续切歌导致 `maintainQueueBuffer` 并发执行，造成重复请求、队列顺序错乱。
3. **MediaSession Timeline 重建**：使用 `reset`、`remove` 等操作会破坏 MediaSession 的稳定性。

**目标**：保证 Android MediaSession 永远认为“还有下一首”，彻底解决按钮消失、队列乱序等问题。

## 🧠 核心架构原则 (工业级标准)

1. **Native Queue 永远 Append-only**：只允许 `TrackPlayer.add()`，绝对禁止在正常播放中 `reset`、`remove` 或 `setQueue`。
2. **扩大 Native Buffer**：将预加载窗口从 3 首扩大到 **8~12 首**，确保用户疯狂切歌也不会掏空队列。
3. **Hydration 必须 SingleFlight**：引入 Promise 锁，防止并发水合，确保队列顺序绝对正确。
4. **Fire-and-forget 触发**：切歌事件只触发异步补队列，绝不 `await` 阻塞 Playback Event Loop。
5. **只追加真实 URL**：彻底摒弃 Placeholder（占位符）方案，避免 JS 挂起导致的死锁。
6. **Hydration 容错**：解析失败直接跳过，绝不卡死队列补充。

## 🚀 详细实施步骤

### 步骤 1：引入 SingleFlight 锁与 Buffer 常量
在 `src/services/trackPlayer.ts` 顶部定义常量和锁变量：
```typescript
const MIN_NATIVE_BUFFER = 8;
const TARGET_NATIVE_BUFFER = 12;
let hydratingPromise: Promise<void> | null = null;
```

### 步骤 2：重构 `maintainQueueBuffer` (核心)
实现 SingleFlight 逻辑，并根据 `MIN_NATIVE_BUFFER` 和 `TARGET_NATIVE_BUFFER` 动态补充队列。
```typescript
async function maintainQueueBuffer() {
  if (hydratingPromise) return hydratingPromise;

  hydratingPromise = (async () => {
    const logicalQueue = usePlayerStore.getState().queue;
    const nativeQueue = await TrackPlayer.getQueue();
    const activeIndex = await TrackPlayer.getActiveTrackIndex();

    if (typeof activeIndex !== 'number') return;

    const remaining = nativeQueue.length - 1 - activeIndex;

    // 增加运行时监控日志.
    LoggerService.info('TrackPlayer', 'maintainQueueBuffer', `nativeLength: ${nativeQueue.length}, activeIndex: ${activeIndex}, remaining: ${remaining}`);

    if (remaining >= MIN_NATIVE_BUFFER) return;

    const need = TARGET_NATIVE_BUFFER - remaining;
    
    // 找到当前播放的逻辑索引
    const activeTrack = nativeQueue[activeIndex];
    if (!activeTrack?.id) return;
    const logicalIndex = logicalQueue.findIndex(v => v.bvid === activeTrack.id);
    if (logicalIndex === -1) return;

    // 计算需要从逻辑队列的哪个位置开始水合
    // 注意：这里需要跳过已经在原生队列中的歌曲
    const nativeIds = new Set(nativeQueue.map(t => t.id));
    const tracksToAdd: Track[] = [];
    let addedCount = 0;
    let i = logicalIndex + 1;

    while (addedCount < need && i < logicalQueue.length) {
      const video = logicalQueue[i];
      if (!nativeIds.has(video.bvid)) {
        try {
          const tracks = await hydrateVideo(video);
          if (tracks.length > 0) {
            tracksToAdd.push(...tracks);
            nativeIds.add(video.bvid);
            addedCount++;
          } else {
            // 容错：解析失败直接跳过，不卡死
            LoggerService.warn('TrackPlayer', 'maintainQueueBuffer', `跳过失效视频: ${video.bvid}`);
          }
        } catch (e) {
           LoggerService.warn('TrackPlayer', 'maintainQueueBuffer', `解析异常跳过: ${video.bvid}`, e);
        }
      } else {
        // 如果已经在原生队列中，算作有效
        addedCount++;
      }
      i++;
    }

    if (tracksToAdd.length > 0) {
      await TrackPlayer.add(tracksToAdd); // Append-only
      LoggerService.info('TrackPlayer', 'maintainQueueBuffer', `成功追加 ${tracksToAdd.length} 首真实轨道`);
    }
  })().finally(() => {
    hydratingPromise = null;
  });

  return hydratingPromise;
}
```

### 步骤 3：重构 `loadQueue` (初始化)
初始化时，一次性加载 `TARGET_NATIVE_BUFFER` 数量的歌曲，建立稳固的初始 Timeline。
```typescript
export async function loadQueue(videos: FavoriteVideo[], startBvid?: string): Promise<number> {
  // ... 前置逻辑 ...
  
  // 初始水合窗口：前1首 + 当前首 + 后 TARGET_NATIVE_BUFFER 首
  const windowStart = Math.max(0, startIndex - 1);
  const windowEnd = Math.min(videos.length, startIndex + TARGET_NATIVE_BUFFER + 1);
  const windowVideos = videos.slice(windowStart, windowEnd);

  // ... 水合逻辑 ...
  
  await TrackPlayer.reset(); // 这是唯一允许 reset 的地方 (全新播放上下文)
  await TrackPlayer.add(hydratedTracks);
  
  // ... 播放逻辑 ...

  // 触发后台水合后续轨道 (Fire-and-forget)
  maintainQueueBuffer().catch(e => {
    LoggerService.error('TrackPlayer', 'loadQueue', 'Background hydration failed', e);
  });
  
  return 1;
}
```

### 步骤 4：清理破坏 Append-only 的逻辑
在 `removeFromQueue` 和 `reorderQueue` 中，**彻底移除 `TrackPlayer.remove()` 的调用**。
如果用户在 UI 上删除了歌曲或重排了列表，我们只更新 Logical Queue (`usePlayerStore.getState().setQueue`)。
Native Queue 保持原样（即使包含已删除的歌），当播放到这些歌时，由于它们不在 Logical Queue 中，我们可以通过逻辑判断跳过它们（或者干脆让它们播放完，这在工业级播放器中是可接受的妥协，以换取 MediaSession 的绝对稳定）。

**修改建议**：
- `removeFromQueue`: 仅更新 Logical Queue。
- `reorderQueue`: 仅更新 Logical Queue，如果当前播放的歌变了，调用 `loadQueue` 重新初始化；否则只触发 `maintainQueueBuffer`。

### 步骤 5：确保事件监听非阻塞
在 `PlaybackActiveTrackChanged` 中，确保调用是 Fire-and-forget：
```typescript
TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, async e => {
  // ... 状态更新 ...
  
  maintainQueueBuffer().catch(err => {
    LoggerService.error('TrackPlayer', 'PlaybackActiveTrackChanged', 'Hydration failed', err);
  });
});
```

## 🎯 预期效果
1. **锁屏疯狂点 Next 不消失**：Buffer 足够大（12首），且 SingleFlight 保证了补充的有序性。
2. **弱网/频控不崩溃**：解析失败直接跳过，不会卡死队列补充；网络慢只会延迟补充，不会破坏当前 MediaSession。
3. **无死锁**：彻底移除了 Placeholder，避免了 JS 挂起导致的播放卡死。