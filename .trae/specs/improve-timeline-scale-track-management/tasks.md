# Tasks

- [x] Task 1: 扩展 Project Document 与 Command Bus
  - [x] SubTask 1.1: 增加工程时间线配置字段，保存用户配置的总时长和默认缩放配置；旧工程无字段时按内容末尾兼容。
  - [x] SubTask 1.2: 增加 `timeline.duration.set` 命令，设置工程总时长时自动不小于最长内容末尾。
  - [x] SubTask 1.3: 增加轨道重排命令，持久化更新 Track `order` 并归一化顺序。
  - [x] SubTask 1.4: 增加轨道删除命令，支持删除空轨道和确认后的级联删除轨道内容。
  - [x] SubTask 1.5: 扩展片段移动命令，支持同事务更新 `trackId` 与 `timelineStartUs`，并保持目标轨道同轨不重叠校验。
  - [x] SubTask 1.6: 更新领域测试，覆盖总时长下限、重排、删除、级联删除和跨轨移动合法/非法场景。

- [x] Task 2: 实现时间线总时长与缩放控制
  - [x] SubTask 2.1: 将时间线显示总长改为 `max(用户配置时长, 内容末尾, 最小时长)`，停止每次添加内容后收缩到内容末尾。
  - [x] SubTask 2.2: 在时间线 toolbar 提供 `1min`、`3min`、`5min`、`10min` 预设和精确时长输入。
  - [x] SubTask 2.3: 当用户输入时长小于最长内容时，保留内容末尾作为实际总长，并展示明确提示。
  - [x] SubTask 2.4: 增加缩放控制，缩放只影响像素密度、标尺和横向滚动宽度，不改变 Project 时间数据。
  - [x] SubTask 2.5: 更新播放头 range、clip/text 样式计算、拖动换算和标尺显示，使其基于显示总长和缩放状态。

- [x] Task 3: 实现轨道重排与删除 UI
  - [x] SubTask 3.1: 为视频、音频和文字轨道头增加拖动排序交互，拖动结束后通过 Command Bus 提交 track order 变更。
  - [x] SubTask 3.2: 为视频、音频和文字轨道头增加删除按钮；含内容轨道删除前弹出确认。
  - [x] SubTask 3.3: 删除轨道后更新 selected clip/text、target video/audio track、playhead 和状态提示，确保 session 不引用已删除轨道。
  - [x] SubTask 3.4: 删除最后一条同类型轨道时采用明确策略：阻止删除并提示，或自动创建替代轨道；实现需与领域校验一致。
  - [x] SubTask 3.5: 更新 Timeline 组件测试，覆盖轨道重排、删除空轨、删除含内容轨和 session 修正。

- [x] Task 4: 实现片段跨轨拖动
  - [x] SubTask 4.1: 扩展拖动状态，识别指针所在目标轨道，并在拖动时同时计算目标 `trackId` 与 `timelineStartUs`。
  - [x] SubTask 4.2: 支持视频片段跨视频轨拖动；音频片段跨音频轨拖动；文字片段跨文字轨拖动。
  - [x] SubTask 4.3: 拒绝跨类型拖动，例如视频到音频、音频到文字。
  - [x] SubTask 4.4: 跨轨拖动提交通过 Command Bus，并与 Undo/Redo 合并为单个连续拖动事务。
  - [x] SubTask 4.5: 目标轨道存在时间冲突时阻止提交或夹紧到最近合法位置，并提供 UI 状态反馈。
  - [x] SubTask 4.6: 更新 timelineMath 和 editor interaction 测试，覆盖跨轨合法移动、跨类型拒绝、目标轨冲突和 Undo/Redo。

- [x] Task 5: 保持预览、导出和文档语义一致
  - [x] SubTask 5.1: 确认预览 runtime 和导出 pipeline 继续完全基于 Track `order` 计算视频/文字叠放顺序。
  - [x] SubTask 5.2: 确认轨道删除后预览、音频播放、导出不会引用已删除轨道或已删除片段。
  - [x] SubTask 5.3: 更新文档，说明工程总时长、缩放、轨道排序/删除和跨轨拖动语义。
  - [x] SubTask 5.4: 更新 Playwright 主流程：设置 10min 总长、缩放时间线、拖动片段到后段、重排轨道、跨轨移动视频片段、删除轨道。
  - [x] SubTask 5.5: 运行相关验证命令，至少覆盖 domain/editor/preview-runtime/export Vitest、editor typecheck、docs:check 和相关 Playwright 用例。

# Task Dependencies

- Task 2 依赖 Task 1 的时间线配置与命令。
- Task 3 依赖 Task 1 的轨道重排/删除命令。
- Task 4 依赖 Task 1 的跨轨 clip move 命令，且与 Task 2 的拖动换算相关。
- Task 5 依赖 Task 1 至 Task 4。
