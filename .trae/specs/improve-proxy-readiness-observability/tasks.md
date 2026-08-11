# Tasks

- [x] Task 1: 梳理并稳定时间线添加策略：明确小视频、长视频、proxy ready、proxy running、proxy failed/cancelled 下的添加行为。
  - [x] SubTask 1.1: 在现有导入和添加流程中识别 direct source fallback、proxy runtime source、OPFS cache hit 的切换点。
  - [x] SubTask 1.2: 为长视频 proxy 未完成时增加清晰 UI 状态和风险提示，不阻塞用户立即添加。
  - [x] SubTask 1.3: 确保 proxy ready 后预览从 source 平滑切到 proxy，不清空已有画面。

- [x] Task 2: 增强 proxy pipeline 可观测性：展示进度、内存、存储和处理时间，帮助判断是否真的卡住。
  - [x] SubTask 2.1: 在 proxy progress payload 中保留 `durationSec`、`processedTimeSec`、`outputBytes`、OPFS temporary/committed bytes 和 storage estimate。
  - [x] SubTask 2.2: 在 UI 展示“已处理媒体时间 / 总时长”、输出字节、OPFS 临时占用、Storage 使用量和主线程 JS heap。
  - [x] SubTask 2.3: 对 Worker heap 等浏览器无法稳定获取的指标标注不可用，避免误导。

- [x] Task 3: 优化长视频 proxy 生成策略：减少首次等待时间并避免固定 5 分钟 timeout 误杀长任务。
  - [x] SubTask 3.1: 对长视频使用轻量 proxy 参数，例如较低 frameRate、较稀疏缩略图间隔和缩略图数量上限。
  - [x] SubTask 3.2: 将 proxy 进度比例从固定 stage 比例改为按 `processedTimeSec / durationSec` 推进。
  - [x] SubTask 3.3: 根据素材时长设置合理 timeout，并保留用户取消能力。

- [x] Task 4: 设计分段 proxy 后续落地接口：先完成类型和文档边界，不一次性重写整条 pipeline。
  - [x] SubTask 4.1: 设计 segment manifest 草案，包含 segment 起止时间、proxy path、keyframes、状态和缓存键。
  - [x] SubTask 4.2: 定义预览读取规则：segment ready 使用 segment proxy，segment missing 使用 source fallback。
  - [x] SubTask 4.3: 暂不实现完整分段转码，避免超出本次修复范围。

- [x] Task 5: 补充长视频性能文档：回答是否需要等待 proxy、内存占用怎么看、WASM/分段/预处理分别适合什么。
  - [x] SubTask 5.1: 在文档中说明“不强制所有视频等 proxy 完成；长视频推荐后台预处理或等待关键 proxy 可用”。
  - [x] SubTask 5.2: 说明 WASM 不适合作为默认视频转码主路径，WebCodecs 仍是编解码主路径。
  - [x] SubTask 5.3: 说明 OPFS 预处理缓存如何复用，以及什么情况下需要清理或重新生成。

- [x] Task 6: 验证与回归：用 `test_1.mp4` 和 `test_2.mp4` 证明体验与指标改进。
  - [x] SubTask 6.1: 验证 `test_1.mp4` 默认日志关闭时播放无大量主线程日志写入，proxy 切换不黑屏。
  - [x] SubTask 6.2: 验证 `test_2.mp4` proxy 进度持续推进，UI 能看到处理媒体时间、输出字节和存储指标。
  - [x] SubTask 6.3: 验证取消长视频 proxy 后不留下不可识别临时文件，重复导入可命中已有缓存。

- [x] Task 7: 加宽 `MEDIA IMPORT` 区域：让素材元数据、proxy 状态、内存/存储和错误信息可读。
  - [x] SubTask 7.1: 审查当前编辑器 grid/flex 布局，定位 `MEDIA IMPORT`、预览区和 Inspector 的宽度约束。
  - [x] SubTask 7.2: 将 `MEDIA IMPORT` 区域视觉宽度扩大到当前约 2 倍，同时保持预览区和 Inspector 可用。
  - [x] SubTask 7.3: 验证小屏幕或窄窗口下布局不会遮挡“添加到时间线”“取消代理”“重试代理”等关键操作。

- [x] Task 8: 修复 `test_3.mp4` proxy 的 PCM sample count mismatch：提供容错、诊断和可重试路径。
  - [x] SubTask 8.1: 复现并定位 `Decoded PCM sample count mismatch: expected 6001008, received 6000640` 的来源，确认是 metadata 舍入、尾部 AAC 解码差异还是 pipeline 截断。
  - [x] SubTask 8.2: 为小幅 PCM 样本数差异实现可解释容错策略，例如按实际解码样本数生成波形，或在阈值内补齐/截断尾部静音。
  - [x] SubTask 8.3: 为不可容忍差异保留失败状态，并在日志/UI 中展示 expected、received、delta、tolerance 和处理策略。
  - [x] SubTask 8.4: 对可恢复 proxy 失败增加“重试代理”入口，复用素材 fingerprint 和当前 proxy 参数。
  - [x] SubTask 8.5: 增加 `test_3.mp4` proxy 回归验证，证明 proxy 不再因小幅 PCM mismatch 失败，或在严重异常时错误信息可诊断。

# Task Dependencies

- Task 1、Task 2、Task 3 可并行分析，但实现时 Task 1 的策略应先稳定。
- Task 4 依赖 Task 1 的 source/proxy fallback 规则。
- Task 5 可与 Task 2、Task 3 并行，但应引用实际验证结果。
- Task 6 依赖 Task 1、Task 2、Task 3 的实现结果；Task 4 只需验证设计边界。
- Task 7 可独立实施，完成后需回归媒体面板关键操作。
- Task 8 依赖 Task 2 的 proxy 诊断展示和 Task 3 的 proxy 参数/缓存键策略；重试入口需与 Task 1 的 proxy 状态提示一致。
