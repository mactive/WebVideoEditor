# 多轨媒体片段裁剪与分片拖动 Spec

## Why
当前多视频/多音频轨道已经支持叠加、跨轨移动和导出，但片段级裁剪与改长在实际交互中还不够完整，用户无法稳定地调整视频和音频片段的可见/可听长度。需要把视频轨和音频轨上的片段裁剪、精确改长、分割后独立拖动统一成可靠的编辑能力。

## What Changes
- 视频片段和音频片段 SHALL 都支持左右边缘拖拽裁剪，并实时更新片段长度。
- 视频片段和音频片段 SHALL 都支持通过属性面板精确修改开始时间、素材入点、素材出点和片段时长。
- 分割后的左右片段 SHALL 作为独立 Clip，可分别拖动、跨同类型轨移动、裁剪和删除。
- 裁剪与改长 SHALL 遵守素材边界、最小时长、同轨不重叠、跨轨可重叠和工程总时长下限。
- 裁剪、改长、拖动和分割 SHALL 全部通过 Command Bus 提交，并支持 Undo/Redo。
- 预览、音频播放和导出 SHALL 使用裁剪后的 `sourceStartUs`、`sourceEndUs` 和 `timelineStartUs`，保证结果与时间线一致。

## Impact
- Affected specs: Project Document、Command Bus、Timeline、Clip Editing、Inspector、Preview Runtime、Audio Playback、Export Pipeline、自动化验收。
- Affected code: `packages/domain/src/commands.ts`、`packages/domain/src/validation.ts`、`apps/editor/src/timeline/Timeline.tsx`、`apps/editor/src/timeline/timelineMath.ts`、`apps/editor/src/inspector/Inspector.tsx`、`packages/preview-runtime/src/*`、`packages/media-runtime/src/audio-playback.ts`、`apps/editor/src/export/export-pipeline.ts`、相关 Vitest/Playwright 用例。

## ADDED Requirements
### Requirement: 多轨媒体片段边缘裁剪
系统 SHALL 允许用户在任意视频轨和任意音频轨上拖动媒体片段左右边缘来裁剪片段。

#### Scenario: 裁剪视频片段开头
- **WHEN** 用户拖动视频片段左边缘向右移动 2 秒
- **THEN** 该 Clip 的 `sourceStartUs` 增加 2 秒
- **AND** `timelineStartUs` 增加 2 秒
- **AND** `sourceEndUs` 保持不变
- **AND** 片段在时间线上的右边界保持不变

#### Scenario: 裁剪音频片段结尾
- **WHEN** 用户拖动音频片段右边缘向左移动 3 秒
- **THEN** 该 Clip 的 `sourceEndUs` 减少 3 秒
- **AND** `timelineStartUs` 与 `sourceStartUs` 保持不变
- **AND** 播放和导出只使用裁剪后的音频区间

### Requirement: 精确修改媒体片段长度
系统 SHALL 在选中视频或音频 Clip 时提供精确数值编辑入口，用于修改片段开始时间、素材入点、素材出点和片段时长。

#### Scenario: 修改片段时长
- **WHEN** 用户把选中音频片段时长改为 8 秒
- **THEN** 系统更新 `sourceEndUs` 使 `sourceEndUs - sourceStartUs = 8s`
- **AND** 若 8 秒超过素材剩余长度或与同轨后续片段冲突，系统阻止提交或夹紧到最近合法值并展示提示

### Requirement: 分割后的片段独立编辑
系统 SHALL 在播放头处分割视频或音频 Clip，并把左右两段作为独立 Clip 管理。

#### Scenario: 分割后拖动右侧片段
- **WHEN** 用户在视频片段中间分割，然后拖动右侧新片段到同类型另一轨道
- **THEN** 左侧片段保持原 `trackId`、`timelineStartUs` 和裁剪区间
- **AND** 右侧片段更新自己的 `trackId` 与 `timelineStartUs`
- **AND** 两段可分别继续裁剪、删除和 Undo/Redo

### Requirement: 裁剪约束与反馈
系统 SHALL 对裁剪和改长应用统一约束，并在无法完全满足用户输入时给出明确 UI 反馈。

#### Scenario: 同轨冲突
- **WHEN** 用户把片段右边缘拖入同一轨道后一个片段的时间范围
- **THEN** 系统不会产生同轨重叠
- **AND** 裁剪结果被阻止或夹紧到后一个片段开始之前
- **AND** UI 展示当前裁剪受同轨冲突限制

#### Scenario: 素材边界
- **WHEN** 用户把片段长度拖到超过素材实际 `durationUs`
- **THEN** 系统不会让 `sourceEndUs` 超过素材时长
- **AND** UI 展示当前裁剪受素材边界限制

## MODIFIED Requirements
### Requirement: 多轨 Clip 编辑
系统 SHALL 支持视频轨和音频轨上的 Clip 选择、移动、跨同类型轨拖动、左右裁剪、精确改长、播放头分割和删除；所有变更 SHALL 通过 Command Bus 执行，并继续保证同一轨道内 Clip 不重叠、不同轨道之间允许重叠。

### Requirement: 音视频预览与导出
系统 SHALL 在预览、音频播放和导出中严格使用每个 Clip 的 `timelineStartUs`、`sourceStartUs`、`sourceEndUs` 和 `trackId`；分割或裁剪后，不得播放、渲染或导出被裁掉的素材区间。

## REMOVED Requirements
### Requirement: 只能移动完整媒体片段
**Reason**: 用户需要对不同轨道上的视频和音频片段分别裁剪、改长和重新拖动分片。
**Migration**: 继续保留完整片段移动行为；新增边缘裁剪、精确时长编辑和分割后独立编辑能力。
