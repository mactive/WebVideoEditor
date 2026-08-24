# ECS System 与 PixiJS Scene Graph

领域模型回答“工程里有什么”，ECS 回答“当前 revision、当前播放头要运行什么”。
`ProjectRuntimeAdapter` 把 Clip/Text 编译成 Miniplex Entity，并按固定顺序执行：

```mermaid
flowchart LR
  P["Project revision + playhead"] --> T["timeline\nactive/localTime"]
  T --> A["animation\nopacity"]
  A --> X["transform\ncanvas coordinates"]
  X --> V["video\nsourceTime"]
  V --> F["effect\nnormalized filters"]
  F --> R["render\nvisible/order"]
  R --> S["Pixi Scene Graph"]
```

Project revision、quality profile 尺寸不变时复用 Entity；revision 变化时更新、创建或释放。
Scene Graph 只保留当前运行对象：每个 active video entity 一个独立视频 Sprite/Texture，
可见 Text 节点和效果 Filter，不反向写 Project。预览 profile 最大 `960×540`；导出 profile
使用 Project exportSettings，但复用同一 ECS 求值和效果归一化。

多视频和文字轨道时，`ProjectRuntimeAdapter.evaluate(...)` 返回按轨道 `order` 排序的
`activeVideos` 和 `activeEntities`。order 小的轨道先绘制，order 大的轨道后绘制；这条规则来自
Track 数据本身，不依赖 `tracks[]` / `clips[]` 数组位置，也不依赖 `video-track`、`text-track`
这类默认 ID。每个视频层保留自己的 transform、effects 和 opacity；播放头、Seek、播放/暂停
仍由同一个工程时间驱动所有层。

revision 变化会触发 ECS rebuild。删除轨道时，Command Bus 会级联删除该轨道上的 Clip/Text；
即使遇到迁移中间态或外部导入留下的孤儿引用，adapter 也只会编译仍指向现存同类型 track 的
video/text entity，并释放上一 revision 中已经不再需要的 entity。

音频轨道不进入 Pixi Scene Graph；PreviewRuntime 会从 Project 中筛出未静音的音频轨 Clip，
按同一播放头交给音频播放模块调度，导出管线则按工程时间把所有可听音频片段混入同一 AAC 输出。
因此视频层叠放由 ECS render order 决定，音频叠加由播放/导出阶段的 mixer 决定。

PixiJS v8 当前明确选择 `preference: "webgl"`。Worker 返回的 VideoFrame 先绘入主线程
frame canvas，再更新 Pixi Texture；消费后由 PreviewRuntime 的 `finally` 调用
`decoded.release()`，最终触发 `VideoFrame.close()`。

## 复现与预期输出

```bash
pnpm --filter @web-video-editor/editor build
pnpm test
```

导入 `test_1.mp4`，加标题和复古滤镜，拖动播放头进入标题范围：

```text
UI: Canvas data-preview-canvas="pixi-v8"，标题/滤镜随时间显示
UI: Preview 指标 Presented Frames 增长，Active Resources 回落
Console: [ECS] revision.rebuilt -> [ECS] evaluate -> [RENDER] present
CLI: editor build 与 runtime-adapter 单测通过
```

## 源码证据

- Entity 编译与 revision rebuild：[packages/preview-runtime/src/runtime-adapter.ts](/source/packages/preview-runtime/src/runtime-adapter.ts.txt)
- 六个 System 的固定顺序：[packages/preview-runtime/src/systems.ts](/source/packages/preview-runtime/src/systems.ts.txt)
- Pixi Scene Graph 与 Filter：[packages/preview-runtime/src/pixi-renderer.ts](/source/packages/preview-runtime/src/pixi-renderer.ts.txt)
- preview/export profile：[packages/preview-runtime/src/quality.ts](/source/packages/preview-runtime/src/quality.ts.txt)
- 生命周期闭环：[packages/preview-runtime/src/preview-runtime.ts](/source/packages/preview-runtime/src/preview-runtime.ts.txt)
