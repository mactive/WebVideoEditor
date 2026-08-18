# 预览快捷键、布局与性能指标优化 Spec

## Why
实时预览是编辑器的核心操作面板，目前播放控制依赖按钮，逐帧检查效率不够高；预览画布和下方实时信息区的排版也显得拥挤。内存指标只展示 `JS Heap`，容易被误解为整机或浏览器总内存，且不足以判断视频预览是否健康。

## What Changes
- 增加全局预览快捷键：空格切换播放/暂停，左方向键上一帧，右方向键下一帧。
- 优化实时预览区内边距和画布排版，让画面、控制条和信息区之间有稳定间距。
- 将实时预览区下方的实时信息区改为可折叠区域，保留快速展开/收起能力。
- 丰富内存性能统计，并让内存/资源相关指标单独占一行展示。
- 明确 `JS Heap` 的语义：它是当前页面主线程可用的 JavaScript heap 采样，不代表整机内存、浏览器进程总内存或 Worker 内部 heap 的精确值。

## Impact
- Affected specs: 实时预览、预览播放控制、预览指标可观测性、编辑器布局响应式。
- Affected code: `apps/editor/src/preview/PreviewPanel.tsx`、`apps/editor/src/preview/PreviewPanel.css`、`apps/editor/src/styles.css`、`packages/media-runtime/src/runtime-metrics.ts`、`apps/editor/e2e/preview.spec.ts`、`apps/editor/e2e/task12-core.spec.ts`、`apps/editor/e2e/task17.spec.ts`、`apps/editor/src/editorInteraction.test.tsx`。

## ADDED Requirements

### Requirement: 全局预览快捷键
The system SHALL provide global keyboard shortcuts for the active preview panel.

#### Scenario: 空格切换播放暂停
- **WHEN** 预览可用且焦点不在文本输入、范围滑块、按钮、下拉框或可编辑区域内，用户按下 `Space`
- **THEN** 预览在播放和暂停之间切换
- **AND** 页面不因该次空格键产生滚动

#### Scenario: 左右方向键逐帧
- **WHEN** 预览可用且焦点不在输入类控件内，用户按下 `ArrowLeft`
- **THEN** 预览跳到上一帧并同步播放头
- **WHEN** 用户按下 `ArrowRight`
- **THEN** 预览跳到下一帧并同步播放头

#### Scenario: 不拦截编辑输入
- **WHEN** 焦点位于 input、textarea、select、button、range slider 或 contenteditable 元素
- **THEN** 全局预览快捷键不处理该按键
- **AND** 原控件保留浏览器默认行为

### Requirement: 实时预览区排版
The system SHALL apply consistent padding and responsive constraints to the embedded realtime preview area.

#### Scenario: 嵌入式预览有稳定内边距
- **WHEN** 用户打开主编辑器页面
- **THEN** 实时预览画布与面板边界、标题、控制条、信息区之间存在清晰间距
- **AND** 画布不会贴边、挤压控制条或导致内容重叠

#### Scenario: 窄屏排版可用
- **WHEN** 页面宽度进入窄屏断点
- **THEN** 预览画布、控制条和信息区按单列或紧凑布局排列
- **AND** 播放、上一帧、下一帧、播放头滑块和折叠按钮仍可见且可操作

### Requirement: 可折叠实时信息区
The system SHALL make the realtime preview metrics area collapsible.

#### Scenario: 默认保留指标可见
- **WHEN** 用户首次进入实时预览区
- **THEN** 实时信息区默认展开，避免丢失现有可观测性

#### Scenario: 用户折叠指标区
- **WHEN** 用户点击实时信息区的折叠控件
- **THEN** 指标详情隐藏
- **AND** 面板保留一行紧凑摘要，至少包含 Source、FPS、JS Heap 或 `N/A`
- **AND** 折叠控件通过 `aria-expanded` 暴露当前状态

#### Scenario: 用户重新展开指标区
- **WHEN** 用户在折叠状态再次点击折叠控件
- **THEN** 指标详情恢复展示
- **AND** 最新采样值继续更新

### Requirement: 内存性能统计单独成行
The system SHALL display memory and resource health metrics as a dedicated row in the preview metrics area.

#### Scenario: JS Heap 解释清晰
- **WHEN** 浏览器提供 `performance.memory`
- **THEN** UI 展示当前页面 JS heap 的 used、total 和 limit 中可用字段
- **AND** 标签或说明明确该指标不是整机内存，也不是 Worker heap 精确值

#### Scenario: JS Heap 不可用
- **WHEN** 浏览器不提供 `performance.memory`
- **THEN** UI 显示 `N/A`
- **AND** 不推断或伪造内存数据

#### Scenario: 内存行包含资源健康指标
- **WHEN** 实时信息区展开
- **THEN** 内存/资源行单独占一行
- **AND** 至少展示 JS Heap、Storage usage/quota、活跃资源、活跃 VideoFrame、视频/音频解码队列和背压计数中的可用指标

## MODIFIED Requirements

### Requirement: 预览控制与播放头同步
The system SHALL keep button controls, keyboard shortcuts, range slider, runtime playhead and editor timeline playhead synchronized. Any successful play, pause, step or seek operation SHALL update the preview runtime snapshot and propagate playhead changes through the existing `onPlayheadChange` path.

### Requirement: 预览指标可观测性
The system SHALL continue showing source mode, preview resolution, FPS, cache hit, dropped/stale frames, active resources and A/V drift when metrics are expanded, while grouping memory and resource-health data into a dedicated row for readability.

## REMOVED Requirements

### Requirement: 始终展开的预览指标区
**Reason**: 指标数量增加后会挤压实时预览区，可折叠能在检查性能和专注画面之间切换。
**Migration**: 默认保持展开以兼容现有调试习惯；新增折叠状态只影响 UI 展示，不改变指标采样和运行时数据。
