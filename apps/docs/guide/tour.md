# 功能导览与项目目录

## 一条完整用户路径

| 阶段 | UI 操作                          | 状态或产物                             | 主要实现                  |
| ---- | -------------------------------- | -------------------------------------- | ------------------------- |
| 导入 | 点测试素材或“选择 MP4”           | Project Asset + 运行时 source          | Media Worker + Mediabunny |
| 代理 | 导入后自动开始，可取消           | OPFS `proxy.mp4`、WebP、`waveform.f32` | Proxy Worker + WASM       |
| 编辑 | 添加片段、裁剪、分割、标题、滤镜 | revision 递增的纯 JSON                 | Command Bus + Redux       |
| 预览 | 播放、逐帧、拖动 Seek            | Worker 解码帧、PixiJS Scene Graph      | RxJS + ECS                |
| 导出 | 点“开始导出”                     | OPFS H.264/AAC MP4 + 下载 URL          | Export Worker             |
| 调试 | 切换日志/JSON/能力/同步          | JSONL、队列、资源、漂移指标            | observability             |

正式编辑器支持动态新增视频轨和音频轨：视频轨按 `track.order` 从低到高叠放，
高 order 轨道覆盖低 order 轨道；音频轨按工程时间混合，静音轨不参与播放或导出。
添加素材默认落在当前播放头，也可以选择追加到当前目标轨尾。旧工程保留默认
`video-track`、`audio-track`、`text-track`，继续作为 V1/A1/T1 使用。
当前仍不包含多人协作、云上传、AI、复杂转场、专业调色或 FFmpeg 全格式兜底。

## 页面入口

- `/`：总编辑器。
- `/mobx.html`：不写正式工程的 MobX 对照实验。
- `/preview.html`：独立预览实验。
- `/sync-debug.html`：音频主时钟和 SAB 环形缓冲调试。
- `http://localhost:5174`：本 VitePress 站点。

## 目录与依赖方向

```text
apps/
  editor/             React UI、Redux、Worker 入口、E2E
  docs/               本中文 VitePress 站点
packages/
  domain/             Project schema、校验、Command、Undo/Redo
  observability/      日志 schema、sink、requestId
  media-wasm/         Rust crate、wasm-bindgen、TS 包装
  media-runtime/      Worker 协议、RxJS、探测、代理、OPFS、同步
  preview-runtime/    ECS adapter、systems、PixiJS、解码客户端
test_assets/          三份只读 MP4
scripts/              verify 与文档校验
```

依赖从应用指向包：`editor -> preview-runtime -> media-runtime`，领域与日志包不依赖 UI；
Redux 不保存 Worker、File、ArrayBuffer、VideoFrame、Pixi 对象。

## 复现与预期输出

```bash
pnpm dev:editor
```

依次点击 `test_1.mp4`、“添加到时间线”、“添加标题”、“开始导出”。

```text
UI: Project Assets 0 -> 1；REV 持续递增
UI: PROXY PIPELINE RUNNING -> READY（或主动 CANCELLED）
UI: Project JSON 中只有 JSON 值，不出现 File/ArrayBuffer/VideoFrame
Console: [IMPORT] -> [COMMAND] -> [ECS]/[RENDER] -> [EXPORT]
CLI: Vite 输出 Local: http://localhost:5173/
```

## 源码证据

- 页面装配和数据所有权：[apps/editor/src/App.tsx](/source/apps/editor/src/App.tsx.txt)
- workspace 脚本与包边界：[package.json](/source/package.json.txt)
- 编辑器依赖版本：[apps/editor/package.json](/source/apps/editor/package.json.txt)
- 核心用户路径测试：[apps/editor/e2e/task12-core.spec.ts](/source/apps/editor/e2e/task12-core.spec.ts.txt)

从[总体架构与线程](/architecture/overview)开始按层阅读。媒体基础概念可先看
[MP4 文件格式详解](/pipeline/mp4-format)和
[帧编码格式 RGB / YUV / YCbCr](/pipeline/frame-formats)，预览取帧细节可看
[预览 Worker 解码链路](/pipeline/preview-worker-decode)。
