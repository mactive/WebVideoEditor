# Tasks

- [x] Task 1: 增加全局预览快捷键
  - [x] SubTask 1.1: 在 `PreviewPanel` 中接入 `keydown` 监听，支持 `Space` 播放/暂停、`ArrowLeft` 上一帧、`ArrowRight` 下一帧。
  - [x] SubTask 1.2: 增加焦点保护，输入框、按钮、滑块、下拉框和 contenteditable 聚焦时不触发全局快捷键。
  - [x] SubTask 1.3: 快捷键成功处理时同步 runtime snapshot 与外层时间线播放头，并只在处理 `Space` 时阻止页面滚动。

- [x] Task 2: 优化实时预览区内边距与响应式排版
  - [x] SubTask 2.1: 调整嵌入式预览面板、stage、canvas、controls、metrics 的间距和尺寸约束，避免画布贴边或内容拥挤。
  - [x] SubTask 2.2: 校验主编辑器三栏布局下预览区不会遮挡控制条、时间线或 Inspector。
  - [x] SubTask 2.3: 补齐窄屏样式，保证播放按钮、逐帧按钮、滑块和指标折叠控件可见可点。

- [x] Task 3: 将实时信息区改为可折叠
  - [x] SubTask 3.1: 为预览指标区增加展开/折叠状态和控制按钮，默认展开。
  - [x] SubTask 3.2: 折叠时保留紧凑摘要，至少展示 Source、FPS、JS Heap 或 `N/A`。
  - [x] SubTask 3.3: 为折叠控件补充 `aria-expanded`、稳定 test id 和无重排的样式约束。

- [x] Task 4: 丰富内存与资源健康指标
  - [x] SubTask 4.1: 将 `JS Heap` 展示为当前页面 JS heap 的 used、total、limit 可用字段，并在 UI 中标明指标边界。
  - [x] SubTask 4.2: 将内存/资源健康指标单独占一行，展示 JS Heap、Storage、活跃资源、活跃 VideoFrame、视频/音频解码队列和背压计数中的可用数据。
  - [x] SubTask 4.3: 不可用指标显示 `N/A`，不推断 Worker heap 或系统总内存。

- [x] Task 5: 验证与回归
  - [x] SubTask 5.1: 增加或更新组件测试，覆盖快捷键触发、焦点保护、折叠状态和摘要展示。
  - [x] SubTask 5.2: 增加或更新 Playwright 用例，验证主编辑器中空格播放/暂停、左右方向键逐帧、折叠指标区和窄屏不遮挡。
  - [x] SubTask 5.3: 运行相关 `pnpm` 验证命令，至少覆盖 editor typecheck、相关 Vitest 和相关 Playwright 预览用例。

# Task Dependencies

- Task 1、Task 2 可并行实施。
- Task 3 依赖 Task 2 的指标区布局边界。
- Task 4 依赖 Task 3 的指标分组结构，但运行时采样逻辑可并行审查。
- Task 5 依赖 Task 1 至 Task 4。
