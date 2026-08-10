# Tasks

- [x] Task 1: 建立 workspace、工具链与可运行外壳
  - [x] SubTask 1.1: 创建 pnpm workspace、React/Vite 编辑器、VitePress 文档站和共享 TypeScript 配置。
  - [x] SubTask 1.2: 固定 Node/pnpm/Rust 版本，配置 lint、format、typecheck、Vitest、Playwright 和统一验证命令。
  - [x] SubTask 1.3: 配置开发服务器访问只读 `test_assets`，设置 COOP/COEP 响应头，并提供编辑器/文档站启动命令。
  - [x] SubTask 1.4: 实现启动能力检测页，输出 WebCodecs、codec、Worker、OPFS、WebGL/WebGPU、OffscreenCanvas、SharedArrayBuffer 和 cross-origin isolation 结果。
  - [x] 验证: 编辑器与文档站可启动/构建，能力结果同时出现在 UI 和 Console。

- [x] Task 2: 定义 Project Document、Command Bus 与持久化
  - [x] SubTask 2.1: 在 `packages/domain` 定义带 schema version 的 Asset、Track、Clip、Text、Effect、Canvas、ExportSettings 类型和 schema 校验。
  - [x] SubTask 2.2: 实现引用完整性、片段边界/非重叠约束、迁移入口和纯 JSON 序列化。
  - [x] SubTask 2.3: 实现 Command Bus、事务合并、Undo/Redo 以及 move/trim/split/delete/text/effect 命令。
  - [x] SubTask 2.4: 使用 Redux Toolkit 保存 Project Document 和 Editor Session，并用 IndexedDB 自动保存/恢复工程 JSON。
  - [x] 验证: 单元测试覆盖命令正反向、事务合并、不变量、迁移和序列化；Redux 中不存在非序列化媒体对象。

- [x] Task 3: 建立结构化日志与链路追踪
  - [x] SubTask 3.1: 在 `packages/observability` 定义统一日志 schema、marker、level、requestId、projectRevision、输入输出摘要和错误序列化。
  - [x] SubTask 3.2: 实现主线程、Worker、WASM 包装层和 CLI 的日志汇聚，避免输出原始大二进制。
  - [x] SubTask 3.3: 实现编辑器日志面板的筛选、搜索、复制、清空和 JSONL 导出。
  - [x] SubTask 3.4: 为 `[CAPABILITY]`、`[COMMAND]`、`[IMPORT]`、`[PROXY]`、`[SEEK]`、`[DEMUX]`、`[DECODE]`、`[WASM]`、`[ECS]`、`[RENDER]`、`[EXPORT]` 建立事件字典和示例。
  - [x] 验证: 一次模拟请求可跨线程按 requestId 还原完整事件顺序，日志通过 schema 测试。

- [x] Task 4: 构建 Rust WASM SDK
  - [x] SubTask 4.1: 创建 Rust crate 和 wasm-bindgen 接口，实现时间/帧/微秒换算及边界测试。
  - [x] SubTask 4.2: 实现分块 PCM min/max/RMS 波形峰值计算，使用 Float32Array 输入输出并支持增量状态。
  - [x] SubTask 4.3: 实现 ArrayBuffer/Uint8Array 校验摘要，用于二进制传输实验，不复制无必要的数据。
  - [x] SubTask 4.4: 提供 wasm-pack 构建、TypeScript 包装、初始化错误和 `[WASM]` 性能日志。
  - [x] 验证: `cargo test`、浏览器 WASM 测试和 JS/Rust 基准样例通过，数值误差与 TypedArray 所有权符合契约。

- [x] Task 5: 定义 Worker 协议、RxJS 调度与资源生命周期
  - [x] SubTask 5.1: 定义版本化判别联合协议，包含 requestId、projectRevision、进度、成功、取消和错误消息。
  - [x] SubTask 5.2: 实现 Worker 客户端、任务注册表、AbortSignal、超时、Transferable 所有权记录和异常恢复。
  - [x] SubTask 5.3: 用 RxJS 实现 Seek `switchMap`、导入/代理并发上限、队列水位、任务进度和取消。
  - [x] SubTask 5.4: 实现 SharedArrayBuffer + Atomics 播放时钟/环形缓冲实验，并在未隔离环境下明确降级。
  - [x] SubTask 5.5: 实现 VideoFrame、AudioData、Decoder、Encoder、Blob URL 和 Worker 的生命周期计数器。
  - [x] 验证: 协议、取消、过期响应丢弃、detached buffer、背压和资源释放集成测试通过。

- [x] Task 6: 实现流式导入、素材探测和 CLI
  - [x] SubTask 6.1: 在 Media Worker 中接入 Mediabunny，以 File/Blob/URL 流式读取容器、轨道、codec、旋转、关键帧和时长。
  - [x] SubTask 6.2: 实现可靠主轨选择，排除 `test_1.mp4`、`test_2.mp4` 中的 MJPEG 封面/附加轨。
  - [x] SubTask 6.3: 计算稳定素材指纹，将小型元数据写入 Project Document，文件句柄/二进制留在运行时。
  - [x] SubTask 6.4: 实现素材面板、文件选择导入和开发环境测试素材清单。
  - [x] SubTask 6.5: 实现素材探测 CLI，输出人类可读 `[PROBE]` 日志与机器可读 JSON。
  - [x] 验证: 三个测试素材元数据与 spec 基线一致；`test_2.mp4` 在首批元数据出现前不整文件读入内存。

- [x] Task 7: 实现代理、缩略图、关键帧索引、波形和 OPFS 缓存
  - [x] SubTask 7.1: 使用 Mediabunny/WebCodecs 在 Worker 中生成最长边不超过 960、画面高度不超过 540 的预览代理。
  - [x] SubTask 7.2: 生成封面、固定间隔缩略图和 Seek 所需关键帧索引。
  - [x] SubTask 7.3: 解码音频 PCM 并调用 Rust WASM 增量生成波形峰值。
  - [x] SubTask 7.4: 使用素材指纹和参数作为 OPFS 缓存键，实现命中、失效、容量统计和清理。
  - [x] SubTask 7.5: 在 UI 展示各阶段进度、取消、cache hit/miss、输入输出尺寸和耗时。
  - [x] 验证: 代理可重新探测和播放；重复导入命中缓存；取消不留下未完成临时文件；波形桶数和值域正确。

- [x] Task 8: 实现 ECS、PixiJS Scene Graph 与低分辨率预览
  - [x] SubTask 8.1: 定义 ECS Entity/Component 和 timeline、animation、transform、video、effect、render System。
  - [x] SubTask 8.2: 实现 Project Document -> Runtime Adapter，按 projectRevision/playhead 创建、更新和回收运行实体。
  - [x] SubTask 8.3: 使用 PixiJS v8 构建视频层、文字层、变换和灰度/复古/亮度对比度滤镜。
  - [x] SubTask 8.4: Worker 按关键帧索引和最新 Seek 请求解码代理 VideoFrame，预览层消费后关闭帧。
  - [x] SubTask 8.5: 实现播放/暂停、逐帧、Seek、代理分辨率显示、FPS、队列、缓存命中、丢帧和活跃资源指标。
  - [x] SubTask 8.6: 共享 ECS 求值和效果参数定义，为导出质量 profile 保留同语义入口。
  - [x] 验证: 标题和滤镜在预览中正确出现；Seek 压测不会呈现过期帧；连续播放后资源计数回落。

- [x] Task 9: 实现音视频时钟与同步
  - [x] SubTask 9.1: 使用单调时钟定义工程时间，存在音频时以音频为主时钟，否则使用 performance clock。
  - [x] SubTask 9.2: 实现音频解码、缓冲、暂停、Seek 失效和片段边界切换。
  - [x] SubTask 9.3: 按时间戳选择/丢弃视频帧，记录 A/V drift、重同步和掉帧原因。
  - [x] SubTask 9.4: 将 SharedArrayBuffer 环形缓冲实验接入调试页，同时保留消息传递降级路径。
  - [x] 验证: 三个测试素材从任意位置播放、暂停和 Seek 后音画时间一致，旧缓冲不会继续播放。

- [x] Task 10: 实现编辑器交互与 MobX 对照实验
  - [x] SubTask 10.1: 构建素材区、预览区、单视频/音频/文字轨时间线、属性面板和调试面板。
  - [x] SubTask 10.2: 接入添加、选择、移动、裁剪、播放头分割、删除、Undo/Redo，并将连续拖动合并为单事务。
  - [x] SubTask 10.3: 实现标题文本、字号、颜色、位置、缩放、旋转、起止时间编辑。
  - [x] SubTask 10.4: 实现 Clip 滤镜选择与参数编辑，确保 Project JSON、ECS 和 PixiJS 一致。
  - [x] SubTask 10.5: 创建隔离 MobX Clip ViewModel 实验页，显示 action、reaction 和 React 重渲染计数，并与 Redux Command 示例对照。
  - [x] 验证: 两素材剪辑、标题、滤镜和 Undo/Redo 核心流程可完成；MobX 不写入正式 Redux Project Document。

- [x] Task 11: 实现原素材高质量导出
  - [x] SubTask 11.1: 在 Export Worker 中复用领域模型和 ECS 求值，按输出 FPS 遍历工程时间并始终选择原素材。
  - [x] SubTask 11.2: 使用 WebCodecs 解码源帧，以 export quality profile 合成标题、变换和滤镜。
  - [x] SubTask 11.3: 使用能力检测后的 VideoEncoder/AudioEncoder 配置编码，并由 Mediabunny 流式 Mux 为 MP4。
  - [x] SubTask 11.4: 实现音频裁剪/拼接、时间戳归一化和输出 A/V 同步。
  - [x] SubTask 11.5: 实现导出进度、ETA、取消、错误恢复、OPFS 临时输出、下载和完成统计。
  - [x] 验证: 短工程导出 MP4 可被重新导入，分辨率、时长、音频、标题和滤镜正确；日志证明输入为 source 而非 proxy。

- [x] Task 12: 完成自动化测试、性能与内存验证
  - [x] SubTask 12.1: 补齐 Domain、Command、RxJS、Worker 协议、WASM、日志和缓存单元/集成测试。
  - [x] SubTask 12.2: 使用 Playwright 覆盖能力检测、导入 `test_1.mp4`、编辑、快速 Seek、Undo/Redo 和短片段导出。
  - [x] SubTask 12.3: 为 `test_2.mp4` 建立可手动触发的大文件流式导入/取消/缓存测试，避免默认 CI 长时间运行。
  - [x] SubTask 12.4: 建立 VideoFrame/AudioData 活跃计数、队列水位、JS heap 可用指标和 OPFS 使用量检查。
  - [x] SubTask 12.5: 执行 lint、typecheck、Rust test、WASM 测试、Vitest、构建和 Playwright，修复所有失败。
  - [x] 验证: 统一验证命令通过，测试输出包含耗时和失败定位，手动性能场景有可复现步骤。

- [x] Task 13: 编写并验证中文文档站
  - [x] SubTask 13.1: 编写快速开始、功能导览、项目目录和完整架构/线程 Mermaid 图。
  - [x] SubTask 13.2: 逐章解释 Project Document、Redux、Command、MobX 对照、RxJS、Worker、TypedArray、WASM、WebCodecs、ECS 和 Scene Graph。
  - [x] SubTask 13.3: 编写导入、代理、音视频预览、基础编辑和高质量导出的源码导读与数据流。
  - [x] SubTask 13.4: 提供 CLI/Console/UI 日志样例，解释 input/output、requestId、revision、背压、资源生命周期和错误排查。
  - [x] SubTask 13.5: 为三个测试素材编写可复现实验、预期结果和性能记录模板。
  - [x] SubTask 13.6: 编写浏览器兼容性、COOP/COEP、OPFS 清理、codec 失败和内存问题排查。
  - [x] SubTask 13.7: 对比 Mediabunny、WebAV、OpenReel、FreeCut、Wazplay、FFmpeg/WASM 等实践，明确借鉴点与本 Demo 边界，不复制第三方实现。
  - [x] SubTask 13.8: 校验所有源码链接、命令、日志样例和文档构建。
  - [x] 验证: 新学习者能仅按文档完成“导入 -> 代理 -> 编辑 -> 预览 -> 导出”并定位每层源码和日志。

- [x] Task 14: 修复运行时验收缺口
  - [x] SubTask 14.1: 补齐 import/probe 的真实运行时验收，验证素材探测结果、流式读取行为和结构化日志。
  - [x] SubTask 14.2: 补齐 preview decode 的真实运行时验收，验证解码帧可呈现、过期帧丢弃和资源释放。
  - [x] SubTask 14.3: 将 export 任务接入 BoundedTaskQueue，记录并验收并发高水位与背压指标。
  - [x] SubTask 14.4: 为 Mediabunny codec 队列提供 adapter；若底层能力无法接入，则提供不夸大能力、边界明确且可验证的可观测替代。
  - [x] SubTask 14.5: 增加 `none -> grayscale -> vintage -> adjustments -> none` 像素 E2E，验证各效果生效且回到 none 后像素恢复。
  - [x] 验证: 运行时验收可复现，关键队列、并发、背压、codec 和像素结果均有机器可校验的证据。

- [x] Task 15: 修复文档验收缺口
  - [x] SubTask 15.1: 忽略 VitePress cache，避免缓存产物进入版本控制和文档验收范围。
  - [x] SubTask 15.2: 统一 capability 事件字典与文档中的事件名、字段、语义和示例。
  - [x] SubTask 15.3: 确保生产文档站的源码导航可点击，且不依赖不存在的 SCM。
  - [x] SubTask 15.4: 修正 `vite preview` 命令及相关文档，确保按文档可直接预览生产构建。
  - [x] SubTask 15.5: 增强 docs 检查，覆盖缓存、事件字典、源码链接和命令有效性，并复跑文档构建与验收。
  - [x] 验证: 文档检查和生产站验收通过，源码导航、命令、事件字典与仓库实际能力一致。

- [x] Task 16: 修复状态同步与能力日志
  - [x] SubTask 16.1: 恢复 Command Bus 到 Redux 的同步链路，确保每次正式命令提交后 Project Document 与 Editor Session 按既有契约更新。
  - [x] SubTask 16.2: 明确 Redux 为唯一正式状态来源，消除 Command Bus、运行时适配器或其他 store 中可独立演进的 Project Document 分叉。
  - [x] SubTask 16.3: 统一 capability 与 WASM 日志的 schema、事件字典、字段语义和示例，确保 UI、Console、Worker/WASM 包装层及文档使用同一契约。
  - [x] SubTask 16.4: 在缺失对应能力时禁用 import、preview 和 SharedArrayBuffer/shared memory 入口，并展示可诊断的降级原因与结构化日志。
  - [x] SubTask 16.5: 为 verify 流程分配专用端口并保证启动、探测和清理一致，避免占用或复用开发/预览服务端口。
  - [x] 验证: 命令执行、Undo/Redo 和持久化恢复均只产生一份 Redux 正式状态；capability/WASM 日志通过统一 schema 与字典校验；缺能力场景的 import、preview、shared memory 均被禁用且原因可观测；verify 可在开发/预览服务并存时使用专用端口稳定通过并释放端口。

- [x] Task 17: 修复媒体与竖屏验收
  - [x] SubTask 17.1: 修复 `test_3.mp4` 首次导入后的画布适配，按素材旋转与宽高信息正确建立竖屏画布、预览尺寸和初始变换。
  - [x] SubTask 17.2: 诊断 `test_1.mp4` 完整代理在隔离执行环境下的超时与可靠性问题，定位阶段、资源和超时边界并完成修复。
  - [x] SubTask 17.3: 增加真实 proxy 生成 E2E，校验输出可探测、可播放、尺寸受限、时长正确且来源与缓存日志完整。
  - [x] SubTask 17.4: 增加真实 thumbnail、waveform 和 preview E2E，校验缩略图像素、波形桶和值域、预览帧呈现及资源释放。
  - [x] SubTask 17.5: 增加竖屏画布与 title 的像素 E2E，验证首次导入适配、标题位置/变换和最终合成像素结果。
  - [x] 验证: `test_3.mp4` 首次导入即以正确竖屏比例和方向呈现；`test_1.mp4` 完整代理在隔离执行下重复运行无超时且结果稳定；真实 proxy、thumbnail、waveform、preview、title 像素 E2E 全部通过并保留机器可校验证据。

- [x] Task 18: 补齐导出完整证据
  - [x] SubTask 18.1: 构造同一真实导出工程，包含按时间线顺序衔接的多个真实素材片段，并为至少一个片段设置非默认 transform。
  - [x] SubTask 18.2: 在该工程中同时加入标题、滤镜和音频，确保导出链路使用原素材并按统一 ECS/Project Document 语义合成。
  - [x] SubTask 18.3: 对真实导出产物保留结构化日志、探测结果和像素/音频证据，证明多片段顺序、transform、标题、滤镜、音频均进入同一产物。
  - [x] SubTask 18.4: 将导出 MP4 重新导入，验证容器与轨道可探测、时长和分辨率正确、音视频可播放且关键画面与原导出证据一致。
  - [x] 验证: 单次真实导出及重导入验收共同证明多片段顺序、非默认 transform、标题、滤镜和音频完整生效，且日志证明输入为 source 而非 proxy。

- [x] Task 19: 修复 `test_3.mp4` 竖屏实验文档与运行时语义不一致
  - [x] SubTask 19.1: 更新 `apps/docs/experiments/assets.md`，明确首次导入 `test_3.mp4` 后工程画布为 1080x1920、代理预览为 304x540，移除仍使用默认 1920x1080 横屏画布的旧描述。
  - [x] SubTask 19.2: 增加文档语义防回归检查，使 `docs:check` 能发现 `test_3.mp4` 首次导入画布描述与 Task 17 E2E 断言不一致。
  - [x] 验证: `pnpm docs:check`、文档生产构建、21 路由 HTTP 巡检和 Task 17 E2E 全部通过，文档步骤与竖屏画布实测一致。

# Task Dependencies

- Task 2、Task 3、Task 4 可在 Task 1 完成后并行。
- Task 5 依赖 Task 1、Task 3、Task 4 的公共契约。
- Task 6 依赖 Task 5；Task 7 依赖 Task 4、Task 5、Task 6。
- Task 8 依赖 Task 2、Task 5、Task 7。
- Task 9 依赖 Task 5、Task 6、Task 8。
- Task 10 依赖 Task 2、Task 8；MobX 对照子任务可与 Task 9 并行。
- Task 11 依赖 Task 2、Task 5、Task 6、Task 8、Task 9。
- Task 12 在各对应模块完成后增量执行，最终验证依赖 Task 11。
- Task 13 可在 Task 1 后按已完成模块增量编写，最终链接和实验校验依赖 Task 12。
- Task 14、Task 15 均依赖 Task 13，二者可并行执行。
- Task 16、Task 17、Task 18 均依赖 Task 14、Task 15，三者可并行执行；最终完整复验按 Task 16 -> Task 17 -> Task 18 串行执行。
- Task 19 依赖 Task 17，修复后需重跑文档检查、生产站 HTTP 巡检和 Task 17 E2E。
