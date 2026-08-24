# Tasks

- [x] Task 1: 保留已完成的多视频轨基础能力
  - [x] SubTask 1.1: Project Document 与 Command Bus 已支持新增多个视频轨道。
  - [x] SubTask 1.2: 时间线已支持多视频轨渲染、选择目标视频轨和同素材重复添加到不同视频轨。
  - [x] SubTask 1.3: 预览与导出已支持多个 active video layer 按轨道 order 叠加。

- [x] Task 2: 扩展领域模型以表达多音频轨和音频片段
  - [x] SubTask 2.1: 增加正式 Command Bus 命令用于新增音频轨道，生成唯一 track id、递增 order、默认 name/muted/locked。
  - [x] SubTask 2.2: 将媒体片段模型扩展为可落在视频轨或音频轨；视频轨片段参与画面合成，音频轨片段参与音频混音。
  - [x] SubTask 2.3: 校验同一轨道内部片段不重叠，不同轨道之间允许重叠；视频轨与音频轨都适用。
  - [x] SubTask 2.4: 保持旧工程兼容：默认 `video-track`、`audio-track`、`text-track` 可迁移或直接继续使用。
  - [x] SubTask 2.5: 更新领域测试，覆盖多音频轨、同素材重复添加到音频轨、跨轨重叠合法、同轨重叠非法。

- [x] Task 3: 改造时间线为多音视频并行叠加编辑
  - [x] SubTask 3.1: 在主编辑器会话中维护当前目标视频轨道和当前目标音频轨道，默认分别使用第一个视频轨与第一个音频轨。
  - [x] SubTask 3.2: 时间线提供新增视频轨、新增音频轨、选择目标轨道的交互，并按 `project.tracks.order` 渲染上下排列的轨道。
  - [x] SubTask 3.3: 添加素材时默认放到当前播放头；同时保留可选的“追加到目标轨尾”能力，避免强制串联。
  - [x] SubTask 3.4: 支持用户通过拖动或数值编辑控制片段 `timelineStartUs`，允许不同轨道的内容从不同时间开始。
  - [x] SubTask 3.5: 将 move/trim/split/delete/Undo/Redo 的边界计算限定到片段所在轨道，不引入跨轨自动挪动。
  - [x] SubTask 3.6: UI 明确区分视频片段和音频片段，同一素材可分别或重复添加到多个视频/音频轨道。

- [x] Task 4: 扩展预览播放为多视频叠加与多音频混音
  - [x] SubTask 4.1: 预览 runtime 继续按 `activeVideos` 调度所有可见视频层，并以同一 playhead 同步所有音频轨道。
  - [x] SubTask 4.2: `AudioTimelinePlayer` 或等价模块支持多个 active audio clip/source 的混合播放，按 `timelineStartUs`、`sourceStartUs`、`sourceEndUs` 定位。
  - [x] SubTask 4.3: 音频轨 `muted` 状态生效；静音轨不进入播放混音，视频轨静音不影响画面可见性。
  - [x] SubTask 4.4: Seek、暂停、继续播放时取消或失效旧音频缓冲，避免旧轨道声音继续播放。
  - [x] SubTask 4.5: 预览指标展示 active video layers、active audio sources、视频/音频队列、背压、A/V drift 和 resync。

- [x] Task 5: 扩展导出为多视频合成与多音频混音
  - [x] SubTask 5.1: 导出视频继续按 `activeVideos` 合成所有可见视频层，并保持 source-only 输入约束。
  - [x] SubTask 5.2: 导出音频按工程时间混合所有 active audio clip，支持不同音频轨的起始偏移和裁剪区间。
  - [x] SubTask 5.3: 被静音的音频轨不进入导出混音；没有可听音频时保持现有无音频导出路径。
  - [x] SubTask 5.4: 保留取消清理、codec 队列水位、背压日志和导出进度指标。
  - [x] SubTask 5.5: 增加导出证据，证明多个视频层和多个音频轨都进入同一 MP4，且输入为 source 而不是 proxy。

- [x] Task 6: 更新测试、E2E 与文档
  - [x] SubTask 6.1: 更新 domain/editor/preview-runtime/media-runtime/export 单元测试，覆盖多音视频轨道、任意开始时间、同轨/跨轨重叠约束。
  - [x] SubTask 6.2: 增加 Playwright 主流程：新增 V2/A2，同素材添加到 V1/V2/A1/A2，分别设置不同起始时间，Seek/播放/暂停后画面和音频状态正确。
  - [x] SubTask 6.3: 扩展导出 E2E，验证重叠视频层、非默认 transform、重叠音频轨和偏移起点都进入导出结果。
  - [x] SubTask 6.4: 更新文档，删除“正式编辑器只支持单视频轨/音频不做多轨混音”的旧描述，说明多音视频轨叠放顺序、添加起点策略和音频混音边界。
  - [x] SubTask 6.5: 运行相关验证命令，至少覆盖 domain/editor/media-runtime/preview-runtime Vitest、editor typecheck、docs:check、相关 Playwright 和导出用例。

# Task Dependencies

- Task 2 依赖 Task 1 的多视频轨基础。
- Task 3 依赖 Task 2 的多音频轨与片段模型。
- Task 4 依赖 Task 2、Task 3。
- Task 5 依赖 Task 2、Task 4 的时间线语义。
- Task 6 依赖 Task 2 至 Task 5；测试可随对应任务增量补齐。
