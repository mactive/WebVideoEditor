# 多音视频轨道叠加编辑 Spec

## Why
当前编辑器已经开始支持多个视频轨道，但上一版范围把音频多轨混音排除在外，并且添加片段仍偏向“追加到轨道末尾”的串联模型。实际目标是更接近常规剪辑时间线：多条视频轨和多条音频轨上下排列、按同一工程时间并行叠加，每个片段都可以从任意时间点开始。

## What Changes
- 时间线 SHALL 支持动态新增多个视频轨道和多个音频轨道，轨道数量不设置硬编码上限。
- 用户 SHALL 能分别选择目标视频轨道和目标音频轨道，并把同一个素材重复添加到任意轨道。
- 添加素材 SHALL 支持按当前播放头或显式开始时间放置片段，允许不同轨道的片段从不同工程时间开始，不强制从 `00:00` 开始，也不强制前后串联。
- 每个轨道内部 SHALL 继续禁止片段时间重叠；不同轨道之间 SHALL 允许同一时间段重叠。
- 视频轨道 SHALL 按轨道 order 叠加合成，order 更大的轨道位于上方，并保留每个视频片段的位置、缩放、旋转、滤镜等效果。
- 音频轨道 SHALL 按同一工程时间混合播放和导出，支持不同音频片段的起始偏移、裁剪区间和轨道静音。
- 播放、暂停、拖动/Seek 和逐帧 SHALL 作为全局 transport 控制所有视频与音频轨道。
- 导出 pipeline SHALL 使用原素材 source 合成所有可见视频层，并混合所有可听音频轨，输出结果与预览时间线语义一致。

## Impact
- Affected specs: Project Document、Command Bus、Timeline、Preview Runtime、Audio Playback、PixiJS Scene Graph、Export Pipeline、自动化验收。
- Affected code: `packages/domain/src/*`、`packages/media-runtime/src/audio-playback.ts`、`apps/editor/src/App.tsx`、`apps/editor/src/timeline/*`、`packages/preview-runtime/src/*`、`apps/editor/src/preview/*`、`apps/editor/src/export/*`、相关 Vitest/Playwright 用例与文档。

## ADDED Requirements
### Requirement: 动态音视频轨道
系统 SHALL 允许在主编辑器中新增视频轨道和音频轨道，并通过 Project Document 持久化。

#### Scenario: 新增音视频轨道
- **WHEN** 用户新增视频轨道或音频轨道
- **THEN** 工程中新增对应 `kind: "video"` 或 `kind: "audio"` 的 Track，具备唯一 id、稳定 order、默认未静音且未锁定
- **AND** 时间线出现对应轨道行

### Requirement: 指定轨道与指定起点添加素材
系统 SHALL 允许用户把素材添加到当前选中的目标视频/音频轨道，并控制片段在工程时间线上的开始时间。

#### Scenario: 不同轨道不同开始时间
- **WHEN** 用户把素材 A 添加到 V1 的 `00:00`，再把素材 A 添加到 V2 的 `03:00`
- **THEN** 工程中出现两个不同 Clip id 的视频片段
- **AND** 两个 Clip 可以引用同一个 `assetId`
- **AND** 两个 Clip 分别保留自己的 `trackId` 与 `timelineStartUs`

#### Scenario: 添加到当前播放头
- **WHEN** 播放头位于 `05:00` 且用户添加素材到选中轨道
- **THEN** 新片段默认从 `05:00` 开始，除非用户显式选择追加到轨道末尾

### Requirement: 跨轨道并行叠加
系统 SHALL 允许不同视频轨道、不同音频轨道上的片段在时间上重叠，并按工程时间并行求值。

#### Scenario: 两个视频轨同一时间都有内容
- **WHEN** V1 与 V2 在同一 playhead 都存在可见视频 Clip
- **THEN** 预览中两个 Clip 都参与渲染
- **AND** order 更大的视频轨道显示在 order 更小的视频轨道之上

#### Scenario: 两个音频轨同一时间都有内容
- **WHEN** A1 与 A2 在同一 playhead 都存在可听音频 Clip
- **THEN** 播放和导出会混合两个音频片段
- **AND** 被静音的音频轨不会进入混音

### Requirement: 多音视频全局 transport
系统 SHALL 使用一个全局播放头控制所有视频轨道和音频轨道的播放、暂停、Seek 和逐帧。

#### Scenario: 拖动播放头
- **WHEN** 用户拖动时间线播放头到任意时间
- **THEN** 所有视频轨道和音频轨道按同一工程时间求值
- **AND** 过期解码或音频缓冲不会覆盖最新播放头对应结果

### Requirement: 多音视频导出
系统 SHALL 在导出时使用原素材为所有可见视频 Clip 合成帧，并混合所有可听音频 Clip。

#### Scenario: 导出重叠音视频轨道
- **WHEN** 工程包含两个重叠的视频轨道、两个重叠的音频轨道，且至少一个视频 Clip 有非默认 transform
- **THEN** 导出 MP4 的关键画面能证明多个视频层及 transform 同时生效
- **AND** 导出音频证据能证明多个音频轨按各自开始时间进入同一输出
- **AND** 导出日志证明输入仍为 source 而不是 proxy

### Requirement: 多轨可观测性
系统 SHALL 在预览和导出指标中暴露多音视频轨道相关的运行时信息。

#### Scenario: 多轨叠加压测
- **WHEN** 多个视频轨道和音频轨道在同一时间可见/可听
- **THEN** UI 或日志能观察到活跃视频层数量、活跃音频源数量、视频/音频解码队列、背压计数、掉帧或 resync 指标

## MODIFIED Requirements
### Requirement: 时间线非重叠约束
系统 SHALL 只在同一个轨道内部禁止 Clip 时间重叠；不同轨道之间的 Clip 时间重叠是合法的叠加编辑行为。

### Requirement: 添加片段时间策略
系统 SHALL 支持把新片段放到当前播放头或用户指定的开始时间；轨尾追加只作为可选行为，不能成为多轨叠加编辑的唯一添加策略。

### Requirement: 预览 runtime 求值
系统 SHALL 同时求值多个 active video entity 与多个 active audio source，并按轨道顺序/混音语义同步给渲染器和音频播放模块。

### Requirement: 导出 frame/audio composition
系统 SHALL 从每帧只选择一个视频 Clip 和单一顺序音频流，扩展为每帧选择所有 active video Clip，并按工程时间混合所有 active audio Clip。

## REMOVED Requirements
### Requirement: 音频仅沿用单轨全局行为
**Reason**: 用户明确要求多条视频+音频轨道上下叠加，并可控制不同轨道内容的开始时间。
**Migration**: 保留现有默认 `audio-track` 作为旧工程的 A1；新增音频轨道和音频混合能力只在用户显式添加或已有多音频轨工程中生效。
