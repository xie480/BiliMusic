# 多P视频播放修复方案

## 1. 数据结构重构
### `src/types/bili.ts`
新增 B 站 API 返回的分P数据结构：
```typescript
export interface BiliVideoPage {
  cid: number;
  page: number;
  from: string;
  part: string;
  duration: number;
  vid: string;
  weblink: string;
  dimension: { width: number; height: number; rotate: number };
}

// 修改 BiliVideoInfo，添加 pages 字段
export interface BiliVideoInfo {
  // ... existing fields
  pages?: BiliVideoPage[];
}
```

### `src/types/domain.ts`
新增应用内部使用的分P数据结构，并在 `FavoriteVideo` 中引入：
```typescript
export interface VideoPart {
  cid: number;
  page: number;
  title: string; // 对应 B 站的 part 字段
  duration: number;
}

export interface FavoriteVideo {
  // ... existing fields
  parts?: VideoPart[]; // 可选，仅在获取到视频详情后填充
}

// 修改 AudioInfo 接口
export interface AudioInfo {
  // ... existing fields
  parts?: VideoPart[];
}
```

## 2. API 与服务层修改
### `src/services/biliApi.ts`
`getVideoInfo` 接口已经返回了 `pages` 字段（B站原生接口包含），只需确保类型定义正确即可。

### `src/services/audioService.ts`
修改 `getInfo` 方法，使其支持传入 `cid`。如果未传入 `cid`，则默认使用视频的第一个 `cid`。
同时，在获取 `videoInfo` 时，提取 `pages` 信息并返回，以便上层更新状态。
```typescript
async getInfo(bvid: string, quality: Quality = 'low', cid?: number): Promise<AudioInfo> {
  // ...
  const info = await cache.getOrSet(
    `videoInfo:${bvid}`,
    config.cacheTTL.videoInfo,
    () => biliApi.getVideoInfo(bvid),
    true
  );

  const targetCid = cid || info.cid;
  const playUrl = await biliApi.getPlayUrl(bvid, targetCid);
  // ...
  const parts = info.pages?.map(p => ({
    cid: p.cid,
    page: p.page,
    title: p.part,
    duration: p.duration
  }));

  return {
    // ...
    cid: targetCid,
    parts,
    // ...
  };
}
```

## 3. 状态管理更新
### `src/store/playerStore.ts`
增加 `currentCid` 状态，用于追踪当前播放的分P。
增加 `updateVideoParts` 方法，用于在获取到视频详情后更新队列中视频的分P信息。
```typescript
interface PlayerState {
  // ...
  currentCid: number | null;
  setCurrentCid: (cid: number | null) => void;
  updateVideoParts: (bvid: string, parts: VideoPart[]) => void;
}
```

## 4. 播放控制逻辑重写 (核心)
### `src/services/trackPlayer.ts`
这是最关键的部分。目前 `loadQueue` 会将每个视频作为一个 `placeholder://${bvid}` 放入队列。
当遇到多P视频时，我们需要在 `lazyResolve` 阶段动态展开它。

**算法设计：**
1. `lazyResolve(index)` 被触发。
2. 解析 `placeholder://${bvid}` 或 `placeholder://${bvid}-${cid}`。
3. 调用 `audioService.getInfo(bvid, quality, cid)`。
4. 检查返回的 `parts`。
   - 如果是首次解析该视频（URL为 `placeholder://${bvid}`）且 `parts` 有多个（多P视频）：
     - 将当前 placeholder 替换为第一P的真实音频 track。
     - 在当前 track 之后，插入剩余分P的 placeholder，格式为 `placeholder://${bvid}-${cid}`。
     - 更新 `playerStore` 中的 `queue`，将该视频的 `parts` 信息补充完整。
   - 如果是解析特定分P（URL为 `placeholder://${bvid}-${cid}`）或单P视频：
     - 直接替换为真实音频 track。

**Track ID 设计：**
为了区分不同分P，TrackPlayer 中的 `id` 应该设计为 `${bvid}-${cid}`（对于多P）或 `${bvid}`（对于单P或未解析的占位符）。

## 5. 表现层修改
### `src/components/PlaylistPanel.tsx`
修改播放列表的渲染逻辑。
- 遍历 `queue` 时，如果某个 `FavoriteVideo` 包含 `parts` 且长度 > 1，则渲染为一个可展开的层级结构。
- 父节点显示视频总标题，子节点显示各分P标题。
- 点击子节点可以调用 `trackPlayer.playSpecificPart(bvid, cid)` 直接跳转播放。
- 拖拽排序时，以整个视频（包含所有分P）为单位进行拖拽。

### `src/components/MiniPlayer.tsx` & `src/screens/PlayerScreen.tsx`
- 监听 `currentCid`。
- 如果当前播放的是多P视频的某个分P，标题显示格式应为 `视频标题 - 分P标题`，或者在 UI 上明确区分。

## 6. 边界情况处理
- **网络断开**：在展开多P占位符时如果网络断开，应保留占位符，等待网络恢复后重试。
- **播放模式**：在随机播放模式下，多P视频内部是否应该打乱？通常逻辑是：多P视频作为一个整体参与随机，但其内部的分P依然保持顺序播放。这需要在 `togglePlayMode` 和 `trackPlayer` 的下一首逻辑中特殊处理。为了简化，第一版可以先实现顺序播放模式下的多P连播。
- **缓存**：`audioCache` 需要支持按 `bvid_cid` 缓存音频文件。
