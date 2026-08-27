# 时间线刻度尺与红色参考线 Spec

## Why
当前时间线播放头 slider 与下方轨道内容区域没有完全左对齐，用户在缩放或调节片段长度时缺少稳定的时间参考。将 slider 替换为带时间戳的刻度尺，并增加贯穿轨道的红色参考线，可以提升拖动、裁剪和精确定位体验。

## What Changes
- 时间线顶部播放头 slider SHALL 替换为可点击/拖动的时间戳刻度尺模式。
- 时间戳刻度尺 SHALL 与下方所有轨道 lane 的内容区域严格左对齐，并共享同一个横向滚动宽度。
- 时间线 SHALL 显示一根红色垂直参考线，表示当前播放头位置，并贯穿刻度尺和轨道区域。
- 红色参考线 SHALL 随播放头、缩放、横向滚动和点击刻度尺同步更新。
- 时间线总长与缩放控制保持现有功能，但其视觉布局不得造成刻度尺和轨道 lane 错位。

## Impact
- Affected specs: Timeline、Clip Editing、时间线缩放、播放头控制、Playwright 视觉验收。
- Affected code: `apps/editor/src/timeline/Timeline.tsx`、`apps/editor/src/timeline/Timeline.css`、`apps/editor/src/timeline/timelineMath.ts`、`apps/editor/src/editorInteraction.test.tsx`、相关 Playwright 用例。

## ADDED Requirements
### Requirement: 时间戳刻度尺播放头控制
系统 SHALL 使用带时间戳的刻度尺替代时间线区域顶部的原生播放头 slider。

#### Scenario: 点击刻度尺定位播放头
- **WHEN** 用户点击刻度尺上的某个时间位置
- **THEN** 播放头更新到对应时间
- **AND** 预览面板、时间线当前时间显示和红色参考线同步到该时间

#### Scenario: 拖动刻度尺定位播放头
- **WHEN** 用户在刻度尺区域按下并水平拖动
- **THEN** 播放头持续更新到拖动位置对应的时间
- **AND** 拖动结果遵守 `0 <= playheadUs <= timelineDurationUs`

### Requirement: 刻度尺时间戳
系统 SHALL 在时间线刻度尺上显示与当前缩放和总时长匹配的时间戳。

#### Scenario: 1 分钟时间线
- **WHEN** 时间线总长为 1 分钟
- **THEN** 刻度尺显示从 `00:00` 到 `1:00.0` 的时间戳
- **AND** 时间戳间距与轨道背景网格、clip 位置和当前缩放一致

#### Scenario: 缩放时间线
- **WHEN** 用户调整时间线缩放
- **THEN** 刻度尺宽度、主刻度、次刻度和时间戳间距随缩放变化
- **AND** 不改变任何 Project 时间数据

### Requirement: 时间线内容左对齐
系统 SHALL 保证刻度尺可编辑区域、红色参考线和下方每条轨道 lane 的内容区域使用同一个左边界。

#### Scenario: 存在轨道标题和删除按钮
- **WHEN** 时间线渲染多条视频、音频或文字轨道
- **THEN** 刻度尺的 `00:00` 位置与每条轨道 lane 的 0 秒位置在同一条垂直线上
- **AND** 轨道标题、删除按钮和其它左侧控制不会挤压或偏移 lane 起点

### Requirement: 红色播放头参考线
系统 SHALL 在时间线区域显示一根红色垂直参考线，用于精确观察当前时间位置和片段长度边界。

#### Scenario: 播放头位于片段边界附近
- **WHEN** 用户拖动片段边缘或移动播放头到片段边界附近
- **THEN** 红色参考线与当前播放头时间精确对齐
- **AND** 参考线贯穿刻度尺和所有可见轨道 lane

#### Scenario: 横向滚动时间线
- **WHEN** 时间线宽度超过可视区域并产生横向滚动
- **THEN** 红色参考线在滚动容器中保持与播放头时间对应的位置
- **AND** 不遮挡轨道头和删除按钮

## MODIFIED Requirements
### Requirement: 时间线播放头交互
系统 SHALL 通过时间戳刻度尺处理时间线播放头定位，不再依赖顶部原生 range slider；播放头变化仍使用现有 `onPlayheadChange` 回调，并保持预览同步、键盘快捷键和 Undo/Redo 语义不变。

### Requirement: 时间线布局
系统 SHALL 将 toolbar、刻度尺和轨道列表拆分为稳定的左右列布局：左侧为轨道控制列，右侧为时间内容列；右侧内容列在所有行中共享相同宽度、左边界和横向滚动语义。

## REMOVED Requirements
### Requirement: 时间线顶部使用原生 range slider 控制播放头
**Reason**: 原生 slider 难以与轨道 lane、网格和时间戳完全对齐，也无法提供足够明确的时间刻度参考。
**Migration**: 使用自定义时间戳刻度尺承接点击和拖动定位能力；保留当前播放头状态与预览同步逻辑。
