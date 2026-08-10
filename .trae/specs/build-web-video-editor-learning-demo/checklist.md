# 验收 Checklist

## 工程与能力

- [x] pnpm workspace 中的编辑器、文档站、领域包、媒体运行时、WASM 和日志包边界清晰，依赖方向无循环。
- [x] 固定的 Node、pnpm、Rust 工具链和所有安装/启动/构建/验证命令可在干净环境执行。
- [x] 编辑器和 VitePress 文档站均可独立启动并完成生产构建。
- [x] 启动页能检测 WebCodecs、codec、Worker、OPFS、WebGL/WebGPU、OffscreenCanvas、SharedArrayBuffer 和 cross-origin isolation。
- [x] 关键能力缺失时，对应按钮被禁用且 UI/日志提供明确原因和建议，不发生静默失败。
- [x] COOP/COEP 配置使 SharedArrayBuffer 实验可用，未隔离环境存在明确降级路径。

## 工程模型与状态

- [x] Project Document 包含 schema version、Asset、Track、Clip、Text、Effect、Canvas 和 ExportSettings，并通过 schema 校验。
- [x] 工程 JSON 可保存、恢复和迁移，且不包含 File、Blob、ArrayBuffer、TypedArray、VideoFrame、AudioData、codec、Worker、Canvas、GPU 或 PixiJS 对象。
- [x] 所有正式工程修改只通过 Command Bus，命令执行前后均检查引用、边界和非重叠不变量。
- [x] Move、Trim、Split、Delete、Text 和 Effect 命令的 Undo/Redo 可精确恢复工程版本。
- [x] 连续拖动编辑被合并为一个事务，并在日志中记录 transactionId、beforeRevision 和 afterRevision。
- [x] Redux Toolkit 是正式 Project Document 和 Editor Session 的唯一状态容器。
- [x] MobX 实验页使用独立 ViewModel，能展示 action/reaction/重渲染计数，且不能修改正式 Redux 工程。

## 日志与可观察性

- [x] 主线程、Worker、WASM 包装层和 CLI 使用同一结构化日志 schema。
- [x] 日志包含 timestamp、level、marker、scope、event、requestId、projectRevision、input、output、durationMs 和 error 的适用字段。
- [x] `[CAPABILITY]`、`[COMMAND]`、`[IMPORT]`、`[PROXY]`、`[SEEK]`、`[DEMUX]`、`[DECODE]`、`[WASM]`、`[ECS]`、`[RENDER]`、`[EXPORT]` 事件均有真实输出。
- [x] 一次 Seek 可按 requestId 从请求、Demux、Decode、ECS 求值追踪到最终呈现。
- [x] 日志只记录二进制类型、长度和摘要，不打印完整视频 packet、PCM 或像素数据。
- [x] UI 日志面板支持筛选、搜索、复制、清空和导出合法 JSONL。
- [x] 素材探测 CLI 同时提供人类可读 `[PROBE]` 输出和机器可读 JSON，失败包含输入路径及完整错误上下文。

## Rust WASM 与二进制

- [x] Rust WASM SDK 通过 wasm-pack 构建，TypeScript 类型和初始化错误处理完整。
- [x] 时间/帧/微秒换算在边界值和常见帧率下通过 Rust 与浏览器测试。
- [x] PCM 分块输入能通过 Float32Array 生成正确桶数和值域的 min/max/RMS 波形。
- [x] 二进制校验接口使用 Uint8Array/ArrayBuffer 并记录摘要，不产生无必要的普通 JS Number 数组。
- [x] Transferable 所有权转移后发送侧不再访问 detached buffer，协议测试能发现违规。
- [x] SharedArrayBuffer + Atomics 只用于高频播放时钟/环形缓冲实验，不承载普通业务状态。

## 媒体导入与缓存

- [x] Media Worker 通过 Mediabunny 流式读取 File/Blob/URL 并提取容器、轨道、codec、旋转、关键帧、时长和音频参数。
- [x] `test_1.mp4` 被识别为 H.264 720x720 30fps + AAC 48kHz 双声道，且不误选 MJPEG 附加轨。
- [x] `test_2.mp4` 被识别为 H.264 1920x1080 30fps + AAC 44.1kHz 双声道，且不误选 MJPEG 附加轨。
- [x] `test_3.mp4` 被识别为 H.264 1080x1920 30fps + AAC 48kHz 双声道，竖屏画布适配正确。
- [x] 约 911 MB 的 `test_2.mp4` 能在未整文件复制到单个 ArrayBuffer 的情况下显示首批元数据和持续进度。
- [x] Redux 只接收素材描述和指纹，文件句柄及二进制保留在 Worker/运行时。
- [x] 代理最长边不超过 960、画面高度不超过 540，可重新探测和播放。
- [x] 封面、缩略图、关键帧索引和 Rust WASM 波形均由真实测试素材生成。
- [x] OPFS 缓存键包含素材指纹与生成参数；重复导入显示 cache hit，参数变化会正确失效。
- [x] 代理取消或失败不会留下不可识别的临时文件，缓存容量和清理操作可观察。

## 调度、Worker 与资源生命周期

- [x] Worker 协议为版本化判别联合，覆盖请求、进度、成功、取消、超时和错误。
- [x] RxJS 使用 switchMap 或等价组合保证快速 Seek 时仅最新请求结果可呈现。
- [x] 导入、代理、解码和导出均有明确并发上限、队列水位和背压日志。
- [x] projectRevision/requestId 不匹配的过期 Worker 响应被丢弃且有统计。
- [x] VideoDecoder/AudioDecoder/VideoEncoder/AudioEncoder 的 queue size 保持在配置水位内。
- [x] 每个 VideoFrame 和 AudioData 在消费后关闭；Decoder、Encoder、Worker 和 Blob URL 在任务结束后释放。
- [x] 连续播放或 Seek 压测至少 2 分钟后，活跃帧/音频对象计数回落到稳定基线。

## ECS、Scene Graph 与预览

- [x] ECS 定义 Entity/Component，并按 timeline、animation、transform、video、effect、render 顺序执行 System。
- [x] Runtime Adapter 能按 Project Document revision 和 playhead 创建、更新和回收 ECS 实体。
- [x] PixiJS Scene Graph 只保存运行对象，不反向成为工程事实来源。
- [x] 预览真实使用代理帧，UI 显示预览分辨率、FPS、队列、缓存命中、掉帧和资源计数。
- [x] 播放、暂停、逐帧、点击 Seek 和连续拖动 Seek 均能工作，旧帧不会覆盖新帧。
- [x] 标题文本、颜色、字号、位置、缩放、旋转和起止时间在预览中正确生效。
- [x] 灰度、复古、亮度/对比度滤镜在预览中正确生效，关闭滤镜可恢复原始画面。
- [x] 一个工程可包含多个顺序视频片段和一个文字轨，时间线、Project JSON 与画面结果一致。

## 音视频同步

- [x] 存在音频时以音频为主时钟，无音频时使用单调 performance clock。
- [x] 播放、暂停、Seek 和片段切换后音视频从同一工程时间恢复。
- [x] Seek 或 revision 变化会使旧音频缓冲失效，不会继续播放过期声音。
- [x] UI 和日志能观测 A/V drift、视频掉帧、重同步和对应原因。

## 高质量导出

- [x] 导出前使用 `isConfigSupported` 或等价能力检查验证视频和音频编码配置。
- [x] Export Worker 按输出时间逐帧求值工程，并复用预览的 ECS 语义和效果参数定义。
- [x] 导出日志明确证明解码输入为原素材 source 而非 540p proxy。
- [x] 导出 MP4 包含正确裁剪、片段顺序、标题、变换、滤镜和对应音频。
- [x] 输出分辨率符合画布/导出设置，输出时长与工程时间线一致，音视频时间戳单调。
- [x] 导出结果可被 Demo 重新导入并识别出有效主视频轨、音频轨、时长和分辨率。
- [x] 导出过程显示阶段、已处理帧、进度、ETA、队列和输出字节数。
- [x] 取消导出会关闭 codec、终止读取、清理 OPFS 临时文件，并允许立即开始新导出。

## 自动化验证

- [x] Domain、Command、迁移、RxJS、Worker 协议、WASM、日志和 OPFS 缓存有针对性单元/集成测试。
- [x] Playwright 覆盖能力检测、导入 `test_1.mp4`、编辑、快速 Seek、Undo/Redo 和短片段导出。
- [x] `test_2.mp4` 大文件流式读取、取消和缓存场景有独立可手动触发测试，不拖慢默认 CI。
- [x] lint、typecheck、Rust test、WASM 浏览器测试、Vitest、生产构建和核心 Playwright 用例由统一命令执行。
- [x] 所有测试和构建通过，失败输出能定位到具体模块、请求或素材。
- [x] 文档中的性能结论均来自实际日志/测试，不包含未经测量的固定性能倍数。

## 文档站

- [x] 文档站包含快速开始、功能导览、目录结构和总体架构/线程 Mermaid 图。
- [x] 文档分别解释 Project Document、Redux、Command、MobX 对照、RxJS、Worker、TypedArray、WASM、WebCodecs、ECS 和 Scene Graph。
- [x] 文档逐阶段解释导入、代理、缩略图、波形、预览、同步、编辑和高质量导出的输入、输出及所有权。
- [x] 文档提供可真实复现的 CLI、Console 和 UI 日志样例，并说明 requestId/revision 链路追踪。
- [x] 文档分别提供 `test_1.mp4`、`test_2.mp4`、`test_3.mp4` 的实验步骤、预期结果和性能记录模板。
- [x] 文档解释 WebCodecs 与 FFmpeg/WASM、Redux 与 MobX、ECS 与领域模型、Structured Clone 与 Transferable/SharedArrayBuffer 的取舍。
- [x] 文档说明 Mediabunny、WebAV、OpenReel、FreeCut、Wazplay 等参考实践中被采用和未采用的部分。
- [x] 文档覆盖浏览器兼容性、COOP/COEP、codec 不支持、OPFS 清理、内存增长和 Worker 错误排查。
- [x] 所有命令、源码链接、日志样例和 Mermaid 图经过实际校验，文档生产构建通过。
- [x] 学习者可仅按文档完成“导入 -> 代理 -> 编辑 -> 预览 -> 导出”并定位对应源码与日志。
