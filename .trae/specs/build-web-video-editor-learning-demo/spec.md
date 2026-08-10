# 浏览器音视频编辑学习 Demo Spec

## Why

`try.md` 已描述适合 Web/桌面视频编辑器的分层架构，但缺少一套可运行、可观察、可验证的端到端示例。本变更将从零构建一个纯浏览器端学习 Demo，覆盖本地视频导入、低分辨率代理预览、基础编辑和原分辨率高质量导出，并通过源码、结构化日志和文档站解释各层职责及数据流。

## What Changes

- 创建基于 pnpm workspace 的 React + TypeScript + Vite 应用和 VitePress 文档站。
- 以 Redux Toolkit 保存可序列化的 Project Document 和 Editor Session，以 Command Bus 约束工程修改并提供事务、Undo/Redo。
- 提供隔离的 MobX 响应式属性面板实验，不与正式 Project Document 共用状态，用于对比 Redux 与 MobX 的更新模型。
- 使用 RxJS 管理导入、代理生成、Seek、播放、解码和导出任务的取消、合并、限流、背压与进度流。
- 使用 Web Worker 隔离媒体探测、代理生成、解码调度、波形计算和导出；主线程只负责 UI、Command 和预览呈现。
- 使用 Mediabunny 完成流式容器读取、Demux、Mux 和 WebCodecs 适配，直接使用 WebCodecs 完成硬件优先的帧级解码与编码。
- 使用 Rust + `wasm-bindgen` 编译学习型 WASM SDK，实际承担时间/帧换算、PCM 波形峰值计算和二进制校验，并以 TypedArray 作为 JS/WASM 边界。
- 使用 ECS 保存当前帧运行实体，使用 PixiJS Scene Graph/WebGL 或 WebGPU 渲染视频层、文字标题和滤镜。
- 使用 ArrayBuffer、TypedArray、Transferable、SharedArrayBuffer、VideoFrame、OffscreenCanvas 和 OPFS 展示二进制、跨线程及零拷贝模式。
- 支持一个视频轨、一个音频轨和一个文字轨；支持多个顺序视频片段、选择、移动、裁剪、分割、删除、标题编辑、变换及基础滤镜。
- 生成 540p 代理用于交互预览，导出时重新读取原始素材并按工程画布/原素材分辨率逐帧渲染，不复用代理帧。
- 提供 UI 日志面板、浏览器 Console JSON 日志和 CLI 日志；日志可筛选、复制并导出 JSONL。
- 提供中文文档站，详细解释架构、完整管线、核心源码导读、日志、性能、内存所有权、测试素材实验和故障排查。
- 使用 `/test_assets/test_1.mp4`、`test_2.mp4`、`test_3.mp4` 作为固定测试集；不修改或复制这些素材。
- 不实现多人协作、云上传、AI 功能、复杂转场、多轨混音、专业调色、移动端适配或 FFmpeg 全格式兜底。

## Impact

- Affected specs: 项目脚手架、工程模型、媒体导入、代理生成、编辑器、预览运行时、导出、WASM SDK、可观察性、文档站、测试
- Affected code:
  - `apps/editor/`: React 编辑器、Redux、Command Bus、RxJS、Worker 客户端、ECS/PixiJS 预览
  - `apps/docs/`: VitePress 中文文档站
  - `packages/domain/`: Project Document、命令、迁移和校验
  - `packages/media-runtime/`: Worker 协议、Mediabunny/WebCodecs 管线、OPFS 缓存
  - `packages/media-wasm/`: Rust WASM SDK
  - `packages/observability/`: 结构化日志契约和日志汇聚
  - `test_assets/`: 只读测试输入

## Architecture Decisions

### 技术栈

| 层 | 选择 | 用途 |
| --- | --- | --- |
| UI | React、TypeScript、Vite | 编辑器界面和开发构建 |
| Project Document | Redux Toolkit | 可序列化、可预测、可调试的唯一事实来源 |
| 对照实验 | MobX | 独立 Inspector 沙盒，展示属性级响应，不进入正式工程链路 |
| 修改入口 | Command Bus | 事务、Undo/Redo、操作日志和不变量校验 |
| 异步调度 | RxJS | `switchMap` 取消 Seek、并发控制、背压、进度组合 |
| 媒体工具 | Mediabunny | 流式读取、容器 Demux/Mux、WebCodecs 适配 |
| 编解码 | WebCodecs | `VideoDecoder`、`AudioDecoder`、`VideoEncoder`、`AudioEncoder` |
| 运行时 | Miniplex ECS | 当前时间可见实体及组件查询 |
| 合成 | PixiJS v8 | Scene Graph、文字、变换、滤镜、WebGL/WebGPU 渲染 |
| 后台执行 | Module Web Worker | 媒体处理、缓存、离线导出 |
| 本地存储 | OPFS、IndexedDB | 大代理/中间文件与小型工程文档分别持久化 |
| WASM | Rust、wasm-bindgen、wasm-pack | 波形、时间线数学和二进制校验 |
| 文档 | VitePress | 中文学习文档和 Mermaid 架构图 |
| 测试 | Vitest、Playwright | 领域逻辑、Worker/WASM 契约和端到端流程 |

Mediabunny 被选为主媒体库，是因为其浏览器优先的流式输入输出、容器读写、WebCodecs 集成和背压能力与本 Demo 的学习目标一致。FFmpeg/WASM 不进入主路径：其软件编解码和大体积不适合代理预览主链路；文档中保留其作为不兼容格式兜底的比较和后续扩展点。

### 数据和线程所有权

```text
React UI
  -> Redux Project Document / Editor Session（仅 JSON）
  -> Command Bus（唯一工程写入口）
  -> Runtime Adapter（Project revision + playhead）
  -> ECS World
  -> PixiJS Scene Graph
  -> Canvas

RxJS Scheduler
  -> Media Worker（Mediabunny + WebCodecs + Rust WASM）
  -> OPFS proxy/cache
  -> VideoFrame / AudioData / TypedArray
  -> Preview Runtime 或 Export Pipeline
```

- Redux 中禁止保存 `File`、`Blob`、`ArrayBuffer`、TypedArray、`VideoFrame`、`AudioData`、Decoder、Encoder、Worker、Canvas、GPU 资源和 PixiJS 对象。
- Project Document 只保存素材 ID、文件指纹、时间线、效果参数、文字参数、画布、导出设置和 schema version。
- 大二进制与代理归 Worker/OPFS；运行帧与纹理归 Preview Runtime；发送方在转移所有权后不得继续访问 detached buffer。
- `VideoFrame`、`AudioData` 和临时 Blob URL 必须在确定的生命周期中关闭或释放。
- SharedArrayBuffer 仅用于播放时钟/音频环形缓冲实验；普通命令和业务状态继续使用消息传递。

### Demo 范围

正式编辑器提供：

- 从文件选择器导入 MP4，或从开发环境的 `/test_assets` 清单载入素材。
- 展示容器、codec、时长、尺寸、帧率、音频采样率、声道和文件大小。
- 为大于 540p 的视频生成最长边不超过 960、画面高度不超过 540 的 H.264 代理；较小素材允许标记为无需代理。
- 生成封面、固定间隔缩略图、关键帧索引和基于 Rust WASM 的音频波形峰值。
- 将素材添加到单视频轨；支持多个不重叠片段顺序排列。
- 支持播放/暂停、逐帧、点击 Seek 和连续拖动 Seek。
- 支持 Clip 选择、移动、首尾裁剪、在播放头分割、删除以及 Undo/Redo。
- 支持一个文字轨；标题可编辑文本、字体大小、颜色、位置、缩放、旋转、起止时间。
- 支持无滤镜、灰度、复古、亮度/对比度三类滤镜并实时预览。
- 预览默认使用代理，显示当前预览分辨率、FPS、解码队列、缓存命中率和丢弃的过期请求数。
- 导出 MP4；视频采用浏览器支持的 H.264 优先配置，音频采用 AAC 优先配置；能力检测失败时阻止任务并给出明确诊断。
- 导出使用源素材分辨率或用户指定画布分辨率，包含裁剪、顺序、文字、变换、滤镜和对应音频，提供进度、耗时、帧数、输出大小和下载。

MobX 实验页提供：

- 一份完全独立的临时 Clip ViewModel。
- 位置、缩放、旋转和透明度属性级响应。
- `action` 修改追踪、reaction 次数和 React 重渲染次数。
- 与 Redux selector/dispatch 示例并列展示；明确说明正式项目不使用 MobX 写入 Project Document。

## ADDED Requirements

### Requirement: 可重复构建的项目基础

系统 SHALL 提供固定 Node、pnpm 和 Rust 工具链说明，以及开发、测试、构建、WASM 编译、素材探测和文档站命令。编辑器与文档站 SHALL 可独立启动和构建。

#### Scenario: 新环境启动

- **WHEN** 开发者按文档安装依赖并执行启动命令
- **THEN** 编辑器和文档站均可访问，WASM 模块被正确加载，CLI 输出各服务地址和能力摘要

### Requirement: 浏览器能力检测

系统 SHALL 在启动时检测 WebCodecs、编码/解码 codec、WebGL/WebGPU、Worker、OPFS、OffscreenCanvas、SharedArrayBuffer 和 cross-origin isolation，并将结果同时显示在 UI 与结构化日志中。

#### Scenario: 关键能力缺失

- **WHEN** 浏览器缺少导入、预览或导出所需的关键能力
- **THEN** 系统禁用对应操作，展示缺失能力、影响和建议浏览器，而不是静默失败

### Requirement: 可序列化工程模型

系统 SHALL 使用带版本号的 Project Document 表达 Asset、Track、Clip、Text、Effect、Canvas 和 ExportSettings，并提供 schema 校验、迁移入口及引用完整性检查。

#### Scenario: 保存和恢复工程

- **WHEN** 用户保存工程并刷新页面
- **THEN** IndexedDB 中的工程 JSON 可恢复，素材引用状态清晰，非序列化运行对象不出现在 JSON 中

### Requirement: Command Bus 与撤销重做

所有正式工程修改 SHALL 通过 Command Bus 执行；连续拖动 SHALL 合并为单个可撤销事务；命令执行前后 SHALL 校验时间线不变量。

#### Scenario: 撤销编辑事务

- **WHEN** 用户移动片段、修改标题并依次执行 Undo/Redo
- **THEN** Project Document 精确恢复到对应版本，预览运行时按 revision 重建，日志包含 command、transactionId、beforeRevision 和 afterRevision

### Requirement: Redux 与 MobX 边界演示

系统 SHALL 使用 Redux Toolkit 承载正式 Project Document/Editor Session，并提供隔离的 MobX 响应式实验页；两个状态容器 SHALL 不共享可变对象或互相写入。

#### Scenario: 比较两种响应模式

- **WHEN** 用户在 MobX 实验页修改单个属性
- **THEN** 页面展示 MobX reaction 与组件重渲染计数，同时说明同等正式编辑动作如何通过 Redux Command 完成

### Requirement: 流式媒体导入

系统 SHALL 通过 Worker 和 Mediabunny 按需读取素材，提取元数据、主音视频轨、旋转和关键帧信息；SHALL NOT 将视频转成 Base64 或把整个大文件复制进 Redux。

#### Scenario: 导入现有测试素材

- **WHEN** 用户依次导入 `test_1.mp4`、`test_2.mp4` 和 `test_3.mp4`
- **THEN** 系统能识别方形 720p、横屏 1080p 长视频和竖屏 1080x1920 视频，选择正确主视频轨而不把 MJPEG 封面轨当作主轨

#### Scenario: 导入约 911 MB 长视频

- **WHEN** 用户导入 `test_2.mp4`
- **THEN** 导入过程按需读取并持续报告字节、阶段和内存指标，不要求先把完整文件复制为单个 ArrayBuffer

### Requirement: 代理、缩略图和波形

系统 SHALL 在 Worker 中生成 540p 级代理、缩略图、关键帧索引和音频波形；代理和大缓存 SHALL 写入 OPFS，并以素材指纹和生成参数作为缓存键。

#### Scenario: 重复导入命中缓存

- **WHEN** 同一素材和相同代理配置被再次导入
- **THEN** 系统复用 OPFS 产物，日志输出 cache hit，且不重复执行完整代理生成

#### Scenario: Rust WASM 波形计算

- **WHEN** Worker 将解码后的 Float32 PCM 分块传入 WASM SDK
- **THEN** SDK 返回固定桶数的 min/max/RMS Float32Array，结果用于时间线波形并记录输入样本数、输出桶数和耗时

### Requirement: RxJS 媒体调度

系统 SHALL 使用 RxJS 表达 Seek、播放、导入、代理和导出任务，使用 `switchMap` 取消过期 Seek，使用并发上限和队列水位实施背压。

#### Scenario: 快速拖动播放头

- **WHEN** 用户在短时间内连续产生多个 Seek
- **THEN** 旧请求被取消或其结果被丢弃，只有最新 revision/time 的帧可呈现，解码队列不无限增长

### Requirement: Worker 通信和二进制所有权

系统 SHALL 定义带版本、requestId、projectRevision、payload 和 error 的判别联合消息协议；大 ArrayBuffer SHALL 通过 Transferable 传递，播放时钟/环形缓冲实验 SHALL 使用 SharedArrayBuffer + Atomics。

#### Scenario: 转移二进制缓冲区

- **WHEN** Worker 向另一线程发送波形、packet 或编码输出缓冲区
- **THEN** 协议记录所有权转移，发送侧不再使用已 detached 的 ArrayBuffer，接收侧能按 TypedArray 类型正确解释数据

### Requirement: WebCodecs 生命周期

系统 SHALL 直接配置和监控 WebCodecs Decoder/Encoder，实施 decodeQueueSize/encodeQueueSize 水位控制，并在消费后关闭每个 VideoFrame 和 AudioData。

#### Scenario: 长时间播放

- **WHEN** 预览连续播放或 Seek 压测至少 2 分钟
- **THEN** 活跃帧计数回落到稳定基线，队列保持在配置上限内，不因遗漏 `close()` 持续增长

### Requirement: ECS 与 Scene Graph 预览

系统 SHALL 将当前 Project Document revision 和 playhead 编译为 ECS 实体/组件，由 System 依次执行 timeline、animation、transform、video、effect 和 render；PixiJS Scene Graph SHALL 只保存当前运行对象。

#### Scenario: 当前帧求值

- **WHEN** 播放头进入含视频、标题和滤镜的时间段
- **THEN** ECS 查询得到对应可见实体，System 更新 PixiJS 节点并以代理帧渲染，离开时间段后资源被释放或回收到池

### Requirement: 基础时间线编辑

系统 SHALL 支持片段添加、选择、移动、裁剪、分割、删除和非重叠约束，并支持一个时间化标题和基础滤镜参数。

#### Scenario: 完成学习型剪辑

- **WHEN** 用户将两个测试素材片段顺序放置、裁剪、添加标题并应用滤镜
- **THEN** 时间线、Project JSON、预览和 Undo/Redo 展示一致结果

### Requirement: 音视频同步预览

系统 SHALL 使用单调播放时钟，以音频为主时钟（无音频时使用 performance clock），按时间戳选择视频帧，并记录漂移、掉帧和重同步。

#### Scenario: 播放带音频片段

- **WHEN** 用户从任意位置开始播放带 AAC 音轨的素材
- **THEN** 声音和画面从相同工程时间启动，暂停/Seek 后旧音频缓冲失效，UI 显示当前 A/V drift

### Requirement: 原素材高质量导出

系统 SHALL 在 Worker 中按输出时间逐帧求值工程，重新读取原素材、解码、以导出质量渲染、编码并 Mux 为 MP4；SHALL NOT 将代理帧作为最终导出源。

#### Scenario: 导出编辑结果

- **WHEN** 用户导出包含裁剪、标题和滤镜的工程
- **THEN** 输出 MP4 可播放、包含音频、分辨率符合导出设置、标题和滤镜与预览语义一致，日志显示 source/proxy 选择为 source

#### Scenario: 取消导出

- **WHEN** 用户在导出过程中点击取消
- **THEN** RxJS 取消信号关闭 Decoder/Encoder、终止读取并清理未完成 OPFS 临时文件，UI 回到可再次导出的状态

### Requirement: 结构化日志与调试面板

系统 SHALL 以统一 JSON schema 输出 `timestamp`、`level`、`marker`、`scope`、`event`、`requestId`、`projectRevision`、`input`、`output`、`durationMs` 和 `error`；敏感二进制只记录长度、类型和摘要，不打印完整内容。

#### Scenario: 追踪一次 Seek

- **WHEN** 用户执行一次 Seek
- **THEN** 可通过同一 requestId 串联 `[SEEK] request`、`[DEMUX] packet`、`[DECODE] frame`、`[ECS] evaluate` 和 `[RENDER] present`，并看到每一步输入输出摘要

#### Scenario: CLI 探测素材

- **WHEN** 开发者执行素材探测 CLI
- **THEN** 终端按素材输出 `[PROBE]` 元数据、主轨选择、能力判断和 JSON 摘要，失败时包含完整输入路径与错误上下文

### Requirement: 中文学习文档站

系统 SHALL 提供可导航、可搜索的中文文档，包含架构图、模块职责、逐阶段管线、核心 API、关键源码链接、日志样例、运行命令、性能观测、内存所有权、浏览器兼容性、测试实验和故障排查。

#### Scenario: 从文档复现实验

- **WHEN** 学习者按“导入 -> 代理 -> 编辑 -> 预览 -> 导出”教程操作测试素材
- **THEN** 每一步都有预期 UI、Console/CLI 日志、数据结构变化和验证方法，并能定位到对应源码

### Requirement: 自动化验证

系统 SHALL 提供领域模型/Command/RxJS/WASM/协议单元测试、浏览器能力与 Worker 集成测试，以及覆盖核心用户路径的 Playwright 测试。

#### Scenario: 执行完整验证

- **WHEN** 开发者执行统一验证命令
- **THEN** lint、typecheck、Rust test、WASM 测试、Vitest、构建和核心 Playwright 用例依次完成并返回明确结果

## Quality and Performance Targets

- Chrome/Edge 最新稳定版为基准浏览器；Safari/Firefox 仅记录能力矩阵，不承诺全部导出 codec。
- 预览代理目标为 540p、30fps；在测试机器能力不足时允许降帧，但必须记录原因和实际 FPS。
- 连续 Seek 期间 Decoder 队列保持在配置水位内，旧请求不会覆盖新请求。
- `test_2.mp4` 的导入和探测不得要求读取完整 911 MB 文件后才显示首批元数据。
- Project JSON 必须保持纯 JSON 且可通过 schema 校验。
- 导出文件必须能被浏览器重新导入并读取到有效主视频轨、时长和分辨率。
- 性能数字必须由运行日志或测试记录产生，文档不得声称未实测的固定倍数。

## Log Contract Examples

```json
{"timestamp":"2026-08-09T12:00:00.000Z","level":"info","marker":"[IMPORT]","scope":"media-worker","event":"probe.completed","requestId":"req_01","input":{"name":"test_2.mp4","size":911401782},"output":{"video":{"codec":"avc1","width":1920,"height":1080,"fps":30},"audio":{"codec":"aac","sampleRate":44100,"channels":2},"durationSec":3207.93},"durationMs":42}
{"timestamp":"2026-08-09T12:00:01.000Z","level":"debug","marker":"[SEEK]","scope":"scheduler","event":"request.superseded","requestId":"seek_41","projectRevision":12,"input":{"timeSec":18.4},"output":{"supersededBy":"seek_42"},"durationMs":3}
{"timestamp":"2026-08-09T12:01:00.000Z","level":"info","marker":"[EXPORT]","scope":"export-worker","event":"completed","requestId":"export_01","projectRevision":17,"input":{"source":"original","width":1920,"height":1080,"fps":30},"output":{"frames":300,"bytes":18420331,"mimeType":"video/mp4"},"durationMs":8420}
```

## Test Asset Baseline

| 素材 | 主视频 | 音频 | 时长/大小 | 重点场景 |
| --- | --- | --- | --- | --- |
| `test_1.mp4` | H.264 High，720x720，30fps | AAC LC，48kHz，2ch | 约 36.05s / 2.88MB | 方形短视频、快速回归 |
| `test_2.mp4` | H.264 High，1920x1080，30fps | AAC LC，44.1kHz，2ch | 约 3207.93s / 911.4MB | 大文件流式读取、缓存和取消 |
| `test_3.mp4` | H.264 High，1080x1920，30fps | AAC LC，48kHz，2ch | 约 125.02s / 141.75MB | 竖屏、旋转/画布适配、高码率 |

`test_1.mp4` 和 `test_2.mp4` 还包含 MJPEG 封面/附加视频流，主轨选择测试必须验证不会误选该流。

## Documentation Outline

- 快速开始与环境要求
- Demo 功能导览
- 总体架构与线程图
- Project Document、Redux、Command Bus、Undo/Redo
- MobX 对照实验及为何不混用工程状态
- RxJS Seek/播放/导出调度
- Worker 协议与任务生命周期
- ArrayBuffer、TypedArray、Transferable、SharedArrayBuffer
- Rust WASM SDK 构建、ABI 和性能测量
- 容器、Mediabunny、WebCodecs、Demux/Decode/Encode/Mux
- 540p 代理、OPFS 缓存、缩略图和波形
- ECS System 与 PixiJS Scene Graph
- 音视频时钟和同步
- 原素材高质量导出
- 结构化日志与 requestId 链路追踪
- 三个测试素材的逐步实验
- 自动化测试、性能与内存检查
- 浏览器兼容性、错误处理和故障排查
- 与 WebAV、OpenReel、FreeCut、Wazplay、FFmpeg/WASM 等方案的边界比较

## Risks and Mitigations

- 浏览器 H.264/AAC 编码支持因平台而异：启动和导出前使用 `isConfigSupported`，不支持时给出可操作错误；可选 WebM 仅作为后续扩展。
- 911 MB 素材会放大内存问题：流式读取、OPFS、Buffer Pool、队列水位和生命周期计数均纳入验收。
- OffscreenCanvas/PixiJS/VideoFrame 跨线程兼容性不同：正式预览允许主线程 Canvas 呈现，但媒体解码保持在 Worker；文档标明实际线程路径。
- SharedArrayBuffer 需要 COOP/COEP：开发服务器配置隔离响应头，并提供未隔离时禁用共享内存实验的降级。
- WASM 不应重复 WebCodecs：WASM 聚焦 CPU 密集、确定性的波形和时间线算法，硬件编解码继续交给 WebCodecs。
- 预览与导出渲染可能语义漂移：共享 ECS 求值和效果参数定义，分别使用 preview/export quality profile，并通过像素/截图测试覆盖。

## MODIFIED Requirements

无。当前工作区不存在既有应用或规格。

## REMOVED Requirements

无。
