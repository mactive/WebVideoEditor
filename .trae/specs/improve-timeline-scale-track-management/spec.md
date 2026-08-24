# 时间线时长缩放与轨道管理 Spec

## Why
当前时间线总长度跟随素材内容自动变化，添加或拖动片段时可编辑范围会跳动，导致调整入场时间和拖动体验别扭。多轨道能力已经具备后，还需要让工程总时长、显示缩放、轨道上下层级和跨轨移动都成为可控编辑对象。

## What Changes
- 时间线 SHALL 支持工程总时长控制，提供 `1min`、`3min`、`5min`、`10min` 预设和精确时长输入。
- 工程总时长 SHALL 至少覆盖当前最长轨道内容，用户输入小于内容末尾时系统 SHALL 自动提升到内容末尾或给出不可缩短提示。
- 时间线 SHALL 支持独立缩放控制；缩放只影响像素密度和横向滚动，不改变工程总时长或片段时间。
- 时间线 SHALL 不再因为每次放入内容而强制把可编辑总长度收缩到内容末尾；手动设置过的总时长应稳定保留。
- 视频、音频、文字轨道 SHALL 支持上下拖动排序，排序通过 Track `order` 持久化并影响视频/文字叠放层级。
- 视频、音频、文字轨道 SHALL 支持删除；删除含内容轨道前必须有明确确认，确认后级联删除该轨道上的片段或文字。
- 视频片段 SHALL 支持跨视频轨道拖动；音频片段 SHOULD 支持跨音频轨道拖动；文字片段 SHOULD 支持跨文字轨道拖动。
- 跨轨拖动 SHALL 同时更新目标轨道和时间起点，并继续遵守目标轨道内部非重叠约束。

## Impact
- Affected specs: Project Document、Command Bus、Timeline、Track Ordering、Clip Editing、Text Editing、Preview Runtime、Export Pipeline、自动化验收。
- Affected code: `packages/domain/src/schema.ts`、`packages/domain/src/commands.ts`、`packages/domain/src/validation.ts`、`apps/editor/src/App.tsx`、`apps/editor/src/store/*`、`apps/editor/src/timeline/*`、`apps/editor/src/inspector/*`、相关 Vitest/Playwright 用例和文档。

## ADDED Requirements
### Requirement: 工程总时长控制
系统 SHALL 提供稳定的工程总时长设置，并支持常用预设和精确输入。

#### Scenario: 使用预设时长
- **WHEN** 用户选择 `3min` 预设
- **THEN** 时间线可编辑范围变为 3 分钟
- **AND** 若当前内容末尾超过 3 分钟，系统将总时长提升到内容末尾并提示无法小于最长内容

#### Scenario: 使用精确时长
- **WHEN** 用户输入精确时长，例如 `00:07:30.000`
- **THEN** 工程保存该时长
- **AND** 时间线标尺、播放头 range、横向滚动区域按该时长展示

### Requirement: 时间线缩放控制
系统 SHALL 提供时间线缩放控制，缩放不改变工程时间数据。

#### Scenario: 缩放时间线
- **WHEN** 用户调整缩放滑杆或缩放按钮
- **THEN** 同一片段的 `timelineStartUs`、`sourceStartUs` 和 `sourceEndUs` 不变
- **AND** 片段在屏幕上的宽度和可拖动精度随缩放变化

### Requirement: 稳定编辑范围
系统 SHALL 将工程总时长与内容自适应分离，避免添加内容后时间线范围反复变化。

#### Scenario: 已设置 10 分钟工程
- **WHEN** 用户设置总时长为 10 分钟并添加一个 5 秒素材
- **THEN** 时间线仍保持 10 分钟可编辑范围
- **AND** 用户可以把该素材拖到任意不冲突的时间点

### Requirement: 轨道上下拖动排序
系统 SHALL 允许用户拖动视频、音频和文字轨道调整上下层级。

#### Scenario: 调整视频轨层级
- **WHEN** 用户把 V1 拖到 V2 上方
- **THEN** 两条轨道的 `order` 持久化更新
- **AND** 预览和导出中 order 更大的视频轨仍显示在更上层

#### Scenario: 调整文字轨层级
- **WHEN** 用户拖动文字轨道排序
- **THEN** 文字轨 `order` 持久化更新
- **AND** 文字叠放顺序与轨道 order 保持一致

### Requirement: 轨道删除
系统 SHALL 支持删除视频、音频和文字轨道，并安全处理轨道内容。

#### Scenario: 删除空轨道
- **WHEN** 用户删除空轨道
- **THEN** 该 Track 从工程中移除
- **AND** 其他轨道 order 被重新归一化为稳定顺序

#### Scenario: 删除含内容轨道
- **WHEN** 用户删除包含片段或文字的轨道并确认
- **THEN** 该轨道及其内容被级联删除
- **AND** 当前选择、目标轨道和播放状态被更新到合法状态

### Requirement: 跨轨道拖动片段
系统 SHALL 支持用户把片段拖动到同类型的其他轨道。

#### Scenario: 视频片段跨视频轨
- **WHEN** 用户把视频片段从 V1 拖到 V2 的 12 秒位置
- **THEN** 该 Clip 的 `trackId` 更新为 V2
- **AND** `timelineStartUs` 更新为 12 秒附近的吸附/换算结果
- **AND** 若 V2 上目标区间冲突，系统阻止提交或将片段夹紧到最近合法位置

#### Scenario: 非同类型轨道
- **WHEN** 用户尝试把视频片段拖到音频轨或文字轨
- **THEN** 系统不会提交跨类型移动
- **AND** 原片段保留在原轨道和原时间

## MODIFIED Requirements
### Requirement: 时间线长度计算
系统 SHALL 使用 `max(userConfiguredDurationUs, contentEndUs, minimumDurationUs)` 作为时间线总时长；未配置用户时长时仍可从内容末尾推导默认时长。

### Requirement: 片段移动命令
系统 SHALL 支持在同一个命令/事务中更新片段的 `trackId` 和 `timelineStartUs`，用于跨轨拖动，同时继续通过 Command Bus 和 Project Validation 约束同轨不重叠。

### Requirement: 轨道顺序语义
系统 SHALL 以 Track `order` 作为时间线显示顺序、视频层级、文字层级和导出叠放顺序的唯一来源；重排后不依赖数组位置或固定轨道 id。

## REMOVED Requirements
### Requirement: 时间线总长完全由内容自适应决定
**Reason**: 内容驱动的总长会导致拖动和入场时间调整时编辑范围不稳定。
**Migration**: 旧工程没有手动时长配置时继续按内容末尾推导；用户一旦设置总时长，就保存并使用手动配置，同时始终不小于内容末尾。
