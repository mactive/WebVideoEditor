# Tasks

- [x] Task 1: 补强领域层 Clip 裁剪与分割语义
  - [x] SubTask 1.1: 审视 `clip.trim`、`clip.split`、`clip.move` 当前实现，确认视频轨和音频轨共用同一套 Clip 约束。
  - [x] SubTask 1.2: 补齐或修正裁剪校验，确保 `sourceStartUs < sourceEndUs`、最小时长、素材 `durationUs`、同轨不重叠和跨轨重叠语义一致。
  - [x] SubTask 1.3: 确保分割后的左右 Clip 保留正确的 `assetId`、`trackId`、`timelineStartUs`、`sourceStartUs`、`sourceEndUs`、transform 和 effects 复制语义。
  - [x] SubTask 1.4: 更新 domain 单元测试，覆盖视频/音频裁剪、改长、分割、非法边界、同轨冲突和 Undo/Redo。

- [x] Task 2: 实现时间线媒体片段左右裁剪交互
  - [x] SubTask 2.1: 确保视频片段和音频片段都显示可操作的左右裁剪手柄，手柄尺寸在当前缩放下可点击。
  - [x] SubTask 2.2: 左边缘裁剪时同步更新 `sourceStartUs` 与 `timelineStartUs`，并保持片段右边界稳定。
  - [x] SubTask 2.3: 右边缘裁剪时更新 `sourceEndUs`，并保持 `timelineStartUs` 与 `sourceStartUs` 稳定。
  - [x] SubTask 2.4: 拖拽过程中按素材边界、最小时长和同轨相邻片段夹紧或阻止提交，并展示明确状态提示。
  - [x] SubTask 2.5: 连续裁剪通过同一个 Command Bus 事务提交，Undo/Redo 能恢复裁剪前后状态。
  - [x] SubTask 2.6: 更新 Timeline 组件测试，覆盖视频轨裁剪、音频轨裁剪、冲突夹紧、缩放后的拖拽换算和事务合并。

- [x] Task 3: 增加属性面板精确改长能力
  - [x] SubTask 3.1: 在选中视频或音频 Clip 时展示片段时长输入，时长由 `sourceEndUs - sourceStartUs` 计算。
  - [x] SubTask 3.2: 修改片段时长时优先调整 `sourceEndUs`，并应用素材边界、最小时长和同轨冲突约束。
  - [x] SubTask 3.3: 保留并校验开始时间、素材入点、素材出点输入，非法输入不应把工程写入无效状态。
  - [x] SubTask 3.4: 更新 Inspector 测试，覆盖精确改长、越界输入、同轨冲突和 Undo/Redo。

- [x] Task 4: 保证分割后分片可重新拖动和裁剪
  - [x] SubTask 4.1: 确保播放头位于 Clip 内部时，分割命令创建右侧新 Clip 并自动选中或可明确选择该新片段。
  - [x] SubTask 4.2: 确保分割后的左右片段可独立移动、跨同类型轨拖动、左右裁剪和删除。
  - [x] SubTask 4.3: 分割后继续遵守同轨不重叠；跨视频轨和跨音频轨移动仍允许重叠。
  - [x] SubTask 4.4: 更新 editor interaction 测试，覆盖视频分割后拖动右段、音频分割后裁剪右段、Undo/Redo 恢复。

- [x] Task 5: 验证预览、音频播放和导出使用裁剪结果
  - [x] SubTask 5.1: 确认 Preview Runtime 按裁剪后的源时间请求视频帧，不渲染被裁掉区间。
  - [x] SubTask 5.2: 确认 Audio Playback 按裁剪后的源时间播放和混音，不播放被裁掉区间。
  - [x] SubTask 5.3: 确认 Export Pipeline 对视频帧和音频混音都使用裁剪后的 `sourceStartUs/sourceEndUs`。
  - [x] SubTask 5.4: 更新相关 runtime/export 测试，覆盖裁剪后预览时间映射、音频裁剪和导出裁剪。
  - [x] SubTask 5.5: 运行相关验证命令，至少覆盖 domain/editor/preview-runtime/media-runtime/export Vitest、editor typecheck 和相关 Playwright 用例。

- [x] Task 6: 补齐 Playwright 验收并修复现有 E2E 失败
  - [x] SubTask 6.1: 修复或更新 `apps/editor/e2e/task12-core.spec.ts` 中标题 Undo 后结束时间断言，使其符合当前时间线语义。
  - [x] SubTask 6.2: 增加最小 Playwright 覆盖：视频左右裁剪、音频左右裁剪、Inspector 片段时长改长、非法输入保护、分割后拖动与 Undo/Redo。
  - [x] SubTask 6.3: 重新运行相关 Playwright 命令并确保通过。

# Task Dependencies

- Task 2 依赖 Task 1 的裁剪约束语义。
- Task 3 依赖 Task 1 的精确裁剪校验。
- Task 4 依赖 Task 1 和 Task 2。
- Task 5 依赖 Task 1 至 Task 4。
- Task 6 依赖 Task 2 至 Task 5。
