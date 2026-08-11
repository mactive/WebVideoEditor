# 优化 Proxy 就绪策略与可观测性 Spec

## Why

长视频 `test_2.mp4` 的 proxy pipeline 可能耗时很长，用户难以判断是否应该等待 proxy 完成后再添加到时间线，也缺少足够清晰的内存、存储和阶段进度证据来判断瓶颈。需要把“立即添加 vs 等待 proxy”的策略、长视频加速路径和可观测指标明确下来。

## What Changes

- 明确时间线添加策略：不强制所有视频都等待 proxy 完成，但按素材规模和 proxy 状态给出风险提示、推荐路径和用户选择。
- 为 proxy pipeline 增加更完整的内存、OPFS、输出字节、阶段处理进度和长任务观测展示。
- 为长视频 proxy 引入可逐步落地的加速策略：缩略图抽样上限、轻量长视频参数、分段 proxy、后台预处理和 OPFS 复用。
- 明确 WASM 的适用边界：优先用于波形、索引、摘要和 CPU 小算法；视频转码主路径继续优先使用 WebCodecs/Mediabunny。
- 增加 `test_2.mp4` 专用的可复现实验与验收，证明长视频不会因为等待整段 proxy 而阻塞基本编辑。
- 将 `MEDIA IMPORT` 区域加宽到当前约 2 倍，使素材元数据、proxy 状态、内存/存储信息可读。
- 针对 `test_3.mp4` proxy 生成失败的 `Decoded PCM sample count mismatch` 增加诊断、容错、重试或前置检测，避免 proxy 失败后只能依赖 source fallback。

## Impact

- Affected specs: 媒体导入、代理生成、时间线添加、预览运行时、可观察性、性能实验、文档站
- Affected code:
  - `apps/editor/src/media/MediaPanel.tsx`: 素材卡片、添加策略、proxy 状态和长视频参数入口
  - `apps/editor/src/App.tsx` / `apps/editor/src/styles.css`: 编辑器主布局与 `MEDIA IMPORT` 区域宽度
  - `apps/editor/src/media/ProxyProgress.tsx`: proxy 进度、内存、存储和处理时间展示
  - `apps/editor/src/App.tsx`: 添加到时间线时的 runtime source 策略
  - `packages/media-runtime/src/proxy-pipeline.ts`: proxy 进度 payload、缩略图/分段策略、内存采样
  - `packages/media-runtime/src/media-proxy-worker.ts`: 长任务进度、取消、分段状态和队列指标
  - `packages/media-runtime/src/proxy-types.ts`: manifest/progress 类型扩展
  - `apps/docs/`: 长视频 proxy 策略、WASM 边界和预处理实验文档

## ADDED Requirements

### Requirement: Proxy 就绪策略

系统 SHALL 不要求所有视频必须等待 proxy pipeline 完成后才能添加到时间线。系统 SHALL 根据素材大小、时长、分辨率、proxy 状态和缓存状态展示推荐策略。

#### Scenario: 小视频立即添加

- **WHEN** 用户导入 `test_1.mp4` 并点击添加到时间线
- **THEN** 系统允许立即添加，预览可先使用原素材直解码，proxy 完成后无黑屏切换到 proxy

#### Scenario: 长视频添加前提示

- **WHEN** 用户导入长视频且 proxy 尚未完成
- **THEN** 系统展示“可立即添加但预览可能较慢”和“等待/后台生成 proxy 后获得更流畅预览”的提示
- **AND** 用户可选择立即添加、等待 proxy、或取消/稍后处理

#### Scenario: Proxy 已缓存

- **WHEN** 用户导入已有 OPFS proxy cache hit 的素材
- **THEN** 系统应直接使用缓存 proxy，添加到时间线不需要重新等待 pipeline

### Requirement: Direct Preview Fallback

系统 SHALL 在 proxy 未完成时保留 direct preview fallback。该 fallback SHALL 明确标记为临时预览路径，并在 proxy 可用后平滑切换。

#### Scenario: Proxy 后台生成中

- **WHEN** 用户已将长视频添加到时间线且 proxy 仍在后台生成
- **THEN** 预览面板显示当前来源为 `source` 或 `proxy`
- **AND** 若使用 `source`，UI 显示潜在性能风险和当前 decode/seek 指标

### Requirement: Proxy Pipeline 内存与存储可观测性

系统 SHALL 在 proxy pipeline 过程中展示可获得的内存和存储指标，包括 JS heap、Storage quota/usage、OPFS committed/temporary bytes、输出字节、临时文件数量、队列水位和处理到的媒体时间。

#### Scenario: 长视频处理观测

- **WHEN** `test_2.mp4` 正在生成 proxy
- **THEN** UI 显示阶段、百分比、已处理媒体时间/总时长、输出字节、耗时、OPFS 临时占用和主线程 JS heap
- **AND** 对无法从 Worker 直接读取的指标，UI 明确标注不可用或仅为主线程估计

### Requirement: 长视频 Proxy 加速策略

系统 SHALL 对长视频采用更适合交互的 proxy 策略，避免缩略图、全段转码和波形一次性阻塞用户判断。

#### Scenario: 缩略图抽样

- **WHEN** 长视频时长远大于普通短视频
- **THEN** 系统限制缩略图数量并按全片均匀抽样，而不是按固定 5 秒间隔生成数百张缩略图

#### Scenario: 轻量长视频参数

- **WHEN** 长视频首次 proxy 生成
- **THEN** 系统可使用较低 proxy frameRate、较稀疏缩略图间隔和更长 timeout
- **AND** 缓存键包含这些参数，避免与高质量 proxy 混淆

### Requirement: 分段 Proxy 可用性

系统 SHALL 支持后续引入分段 proxy manifest，使长视频可以在前几个片段完成后先用于预览，而不是等待整段视频完成。

#### Scenario: 首段可用

- **WHEN** 长视频第一个 proxy segment 已完成
- **THEN** 时间线前段预览可使用该 segment
- **AND** 尚未完成的时间范围继续使用 source fallback 或显示“该范围 proxy 未就绪”

### Requirement: 预处理与持久化复用

系统 SHALL 支持把已生成的 proxy、缩略图、波形和索引持久化到 OPFS，并在重复导入或重新打开项目时复用。

#### Scenario: 提前预处理

- **WHEN** 用户选择“后台预处理素材”
- **THEN** 系统在不添加到时间线的情况下生成并缓存 proxy artifact
- **AND** 之后添加到时间线时可直接使用缓存结果

### Requirement: WASM 加速边界

系统 SHALL 明确 WASM 不作为 H.264/AAC 视频转码主路径的默认方案。WASM SHALL 优先用于波形、索引、校验、分段调度计算和小型 CPU 密集逻辑；视频解码/编码 SHALL 优先使用 WebCodecs 硬件路径。

#### Scenario: 加速建议展示

- **WHEN** 用户查看长视频性能说明
- **THEN** 文档解释 WebCodecs/Mediabunny、WASM、分段和预处理各自能解决的问题与限制

### Requirement: MEDIA IMPORT 宽度与信息可读性

系统 SHALL 为 `MEDIA IMPORT` 区域提供足够宽度，使素材元数据、proxy 状态、内存/存储指标和错误信息可读。当前编辑器布局中，`MEDIA IMPORT` 宽度 SHALL 扩展到现有视觉宽度约 2 倍，且不破坏预览区和 Inspector 的基本可用性。

#### Scenario: Proxy 失败信息可读

- **WHEN** `test_3.mp4` 的素材卡片展示 `proxy=failed`、OPFS、Storage、Heap 和错误文本
- **THEN** 用户无需横向猜测或过度压缩即可看到主要信息

#### Scenario: 小屏幕降级

- **WHEN** 视口宽度不足以同时容纳加宽后的媒体区、预览区和 Inspector
- **THEN** 布局允许换行、滚动或按既有响应式规则降级，不遮挡关键操作按钮

### Requirement: Proxy 音频样本数容错与诊断

系统 SHALL 处理真实素材中音频解码样本数与按 metadata 估算值存在小幅误差的情况。对于 `Decoded PCM sample count mismatch`，系统 SHALL 区分可容忍尾部舍入误差与真实数据损坏，并提供诊断日志、前置风险检测或自动重试策略。

#### Scenario: `test_3.mp4` 小幅 PCM 样本数误差

- **WHEN** `test_3.mp4` proxy pipeline 解码得到的 PCM sample count 与 `durationSec * sampleRate` 估算值存在小幅差异
- **THEN** 系统不应直接使整个 proxy 失败
- **AND** 波形输出应基于实际解码样本数或可解释的尾部补齐/截断策略生成
- **AND** 日志和 UI 应展示 sample mismatch 的 expected、received、delta 和处理策略

#### Scenario: PCM 样本数严重不一致

- **WHEN** decoded PCM sample count 与 expected sample count 差距超过配置阈值
- **THEN** 系统应保留失败状态或降级策略，并明确提示可能是素材异常、metadata 不准确或解码不完整

#### Scenario: 可重试 Proxy 失败

- **WHEN** proxy 失败原因属于可恢复类型，例如 PCM 尾部舍入误差、临时 OPFS 写入失败或任务超时
- **THEN** UI SHOULD 提供“重试代理”入口
- **AND** 重试应复用已知素材 fingerprint 和当前 proxy 参数，不需要用户重新导入素材

## MODIFIED Requirements

### Requirement: 代理、缩略图和波形

系统 SHALL 在 Worker 中生成 proxy、缩略图、关键帧索引和音频波形，并写入 OPFS。对于长视频，系统 SHALL 使用受控缩略图数量、可配置 proxy 参数、可取消/恢复的后台任务和清晰的进度/内存展示，避免用户误以为 pipeline 卡死。对于音频样本数小幅不一致的真实素材，系统 SHALL 采用可解释的容错策略，不因尾部舍入误差直接导致整个 proxy 失败。

### Requirement: 时间线添加

系统 SHALL 允许素材在 proxy 未完成时添加到时间线，但必须明确当前预览路径、性能风险和 proxy 后台状态。系统 SHOULD 对长视频提供等待 proxy 或后台预处理的推荐入口。

## REMOVED Requirements

无。
