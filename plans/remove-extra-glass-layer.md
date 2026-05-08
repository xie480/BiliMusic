# 移除 SoundLabScreen EQ 均衡器界面多余磨砂玻璃层

## 问题分析

在 `SoundLabScreen` 的 EQ 均衡器调试界面中，存在两层嵌套的磨砂玻璃背景。

### 当前代码结构分析

```
App.tsx: withBackground(SoundLabScreen) → 玻璃模式下 background = 'transparent'
  └── SoundLabScreen.tsx
      ├── <Header /> (标题栏)
      ├── <ScrollView> (上部可滚动区)
      │   ├── presetSection (预设选择器, 无背景)
      │   ├── spectrumCard (t.colors.surface 背景 ← 内层磨砂玻璃层 1)
      │   └── detailCard (t.colors.surface 背景 ← 内层磨砂玻璃层 2)
      └── bottomConsole (t.colors.surface 背景 ← 外层磨砂玻璃层)
          ├── controlBar (无背景)
          ├── modeRow (无背景)
          └── eqScrollArea (无背景) → GraphicEQ / ParametricEQ
```

### 关键发现

1. **外层磨砂玻璃**: `bottomConsole` 使用 `backgroundColor: t.colors.surface`
   - 玻璃模式下: `t.colors.surface` = `rgba(18, 18, 24, 0.48)`（深色）或 `rgba(255, 255, 255, 0.45)`（浅色）
   - 普通模式下: `t.colors.surface` = `#18191C`（深色）或 `#F7F8FA`（浅色）

2. **内层磨砂玻璃**: `spectrumCard` 和 `detailCard` 同样使用 `backgroundColor: t.colors.surface`
   - 它们位于 ScrollView 中，视觉上位于 `bottomConsole` 上方/内侧
   - 两者使用相同的 `surface` 色值，形成两层叠加深色/白色背景的效果

### 问题总结

在 EQ 均衡器界面中：
- `bottomConsole`（底部固定控制台）已有磨砂玻璃背景
- 上方 ScrollView 中的 `spectrumCard`（频谱卡片）和 `detailCard`（频段详情卡片）也使用了同样的磨砂玻璃背景
- 这导致视觉上出现"两层嵌套的磨砂玻璃"效果，显得冗余

## 修改方案

**只保留最外层 `bottomConsole` 的磨砂玻璃效果**，将内层卡片的背景改为透明。

### 修改步骤

1. 在 `SoundLabScreen.tsx` 中，移除 `spectrumCard` 和 `detailCard` 的 `backgroundColor: t.colors.surface`
2. 将它们设为无背景（透明），让底层 `GlassBackground` 的动画渐变直接透出

### 具体改动

```diff
- <View style={[styles.spectrumCard, { backgroundColor: t.colors.surface }]}>
+ <View style={[styles.spectrumCard]}>

- <View style={[styles.detailCard, { backgroundColor: t.colors.surface }]}>
+ <View style={[styles.detailCard]}>
```

### 视觉效果预期

- 修改前: 两层磨砂玻璃层层叠，界面显得沉重
- 修改后: 只有底部的 `bottomConsole` 保留磨砂玻璃效果，上方的频谱和频段区域直接透出底层动画背景，界面更轻盈通透

## 影响范围

| 文件 | 修改内容 |
|------|----------|
| `src/screens/SoundLabScreen.tsx:96` | `spectrumCard` 的 `backgroundColor` 移除 |
| `src/screens/SoundLabScreen.tsx:110` | `detailCard` 的 `backgroundColor` 移除 |

该修改对 **Glass 模式**（`glass-light` / `glass-dark`）影响最大；
对 **普通模式**（`light` / `dark`）则会让卡片变为透明，直接显示 `background` 颜色，视觉上会更统一简洁。
