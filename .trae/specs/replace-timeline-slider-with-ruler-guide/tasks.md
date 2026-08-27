# Tasks

- [x] Task 1: 梳理时间线布局与播放头现状
  - [x] SubTask 1.1: 审视 `Timeline.tsx` 和 `Timeline.css` 中 toolbar、ruler、tracks 的 DOM 结构和 CSS grid 宽度来源。
  - [x] SubTask 1.2: 确认当前播放头 slider、轨道 lane、clip 定位、缩放宽度和横向滚动之间的数据关系。
  - [x] SubTask 1.3: 明确不需要修改 Project Document、Command Bus、Preview Runtime 或 Export Pipeline。

- [x] Task 2: 实现与轨道 lane 左对齐的时间戳刻度尺
  - [x] SubTask 2.1: 移除时间线区域顶部原生播放头 range slider 的视觉实现。
  - [x] SubTask 2.2: 增加自定义刻度尺层，显示主刻度、次刻度和时间戳标签。
  - [x] SubTask 2.3: 确保刻度尺内容列与轨道 lane 的 0 秒位置严格左对齐。
  - [x] SubTask 2.4: 刻度尺宽度随当前显示总长和 `pixelsPerSecond` 缩放同步变化。

- [x] Task 3: 实现刻度尺点击和拖动定位播放头
  - [x] SubTask 3.1: 点击刻度尺时将指针 x 坐标转换为 `playheadUs` 并调用 `onPlayheadChange`。
  - [x] SubTask 3.2: 在刻度尺上拖动时持续更新播放头，并把结果夹紧到 `[0, durationUs]`。
  - [x] SubTask 3.3: 保持当前播放头时间显示、预览同步和已有全局快捷键行为不变。

- [x] Task 4: 增加红色播放头参考线
  - [x] SubTask 4.1: 在时间线内容列中渲染红色垂直参考线，位置由 `playheadUs` 和 `pixelsPerSecond` 计算。
  - [x] SubTask 4.2: 参考线贯穿刻度尺和所有可见轨道 lane，不覆盖左侧轨道标题和删除按钮。
  - [x] SubTask 4.3: 参考线随播放头变化、缩放变化和横向滚动保持对齐。
  - [x] SubTask 4.4: 保持 clip 裁剪手柄仍可点击和拖动，参考线不拦截指针事件。

- [x] Task 5: 更新测试与验收
  - [x] SubTask 5.1: 更新或替换依赖 `role=slider`、`aria-label=时间线播放头` 的 editor interaction 测试。
  - [x] SubTask 5.2: 增加刻度尺点击/拖动会调用 `onPlayheadChange` 的组件测试。
  - [x] SubTask 5.3: 增加刻度尺与 lane 左对齐、红色参考线位置随缩放变化的断言。
  - [x] SubTask 5.4: 运行 `pnpm --filter @web-video-editor/editor typecheck` 和相关 editor 测试。

# Task Dependencies

- Task 2 依赖 Task 1 的布局梳理。
- Task 3 依赖 Task 2 的刻度尺 DOM。
- Task 4 依赖 Task 2 的统一内容列布局。
- Task 5 依赖 Task 2 至 Task 4。
