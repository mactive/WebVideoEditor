---
layout: home

hero:
  name: 浏览器音视频编辑学习 Demo
  text: 从真实代码走完导入、剪辑、预览与导出
  tagline: React + Redux + RxJS + Worker + Rust WASM + Mediabunny + WebCodecs + ECS + PixiJS
  actions:
    - theme: brand
      text: 开始实验
      link: /guide/tour
    - theme: alt
      text: 查看线程架构
      link: /architecture/overview

features:
  - title: 原素材导出
    details: 代理只服务预览；Export Worker 重新读取原素材并输出 H.264/AAC MP4。
  - title: 可观测管线
    details: UI、Console、CLI 使用同一结构化日志约定，requestId 串联跨线程任务。
  - title: 可执行证据
    details: 三份固定素材、Vitest、Rust/WASM 测试与 Playwright 核心流程均纳入统一验证。
---

# 快速开始与环境要求

本页命令均从仓库根目录 `/Users/bytedance/Documents/WebEditorSketch` 执行。固定版本来自
[package.json](/source/package.json.txt)、[rust-toolchain.toml](/source/rust-toolchain.toml.txt) 和
[pnpm-lock.yaml](/source/pnpm-lock.yaml.txt)：Node `22.17.0`、pnpm `10.13.1`、Rust `1.92.0`；
本机实测 `wasm-pack 0.15.0`。

## 安装与启动

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build:wasm
pnpm dev:editor
```

编辑器地址为 `http://localhost:5173`。另开终端：

```bash
pnpm dev:docs
```

文档地址为 `http://localhost:5174`。不要双击 `dist/index.html`：文件协议不会带
COOP/COEP 响应头，SharedArrayBuffer 会降级。

生产文档站可直接预览：

```bash
pnpm --filter @web-video-editor/docs build
pnpm --filter @web-video-editor/docs preview
```

“源码证据”链接指向构建时从当前工作区生成的 `/source/*.txt`，不依赖 GitHub 或其他
SCM。文档构建会逐个巡检这些生产站链接并要求 HTTP 200。

## 首次操作

1. 打开编辑器，点调试区“能力”，确认 `worker`、`opfs`、`h264Decode`、
   `h264Encode`、`aacEncode` 为 `YES`。
2. 在“开发测试素材”点 `test_1.mp4`；状态从 `PROBING` 变为 `READY`。
3. 点“添加到时间线”，拖动播放头；代理未完成时先用原素材，完成后切到 OPFS 代理。
4. 选择片段，设置源入/出点与滤镜；点“添加标题”后编辑文字。
5. 点“开始导出”，完成后下载 MP4；面板必须显示 `source=original`。

**预期 UI**

```text
总编辑器
REV <递增整数>
素材探测: test_1.mp4 READY
预览: READY / 960×540 或源尺寸 / Decode Queue 0
高质量 MP4 导出: source=original
```

**预期 Console**

Console 每行是 JSON；实际时间、requestId、耗时和字节数随机器变化：

```json
{"level":"info","marker":"[IMPORT]","scope":"media-worker","event":"probe.completed","requestId":"media.probe_..."}
{"level":"info","marker":"[COMMAND]","scope":"editor-command","event":"execution.completed","projectRevision":2}
{"level":"info","marker":"[EXPORT]","scope":"export-worker","event":"completed","input":{"source":"original"}}
```

## CLI 探测与统一验证

```bash
pnpm media:probe -- test_assets/test_1.mp4
pnpm docs:check
pnpm --filter @web-video-editor/docs build
pnpm verify
```

CLI 预期依次出现 `[PROBE] metadata`、`main-track.selected`、`capability`、`summary`。
`pnpm verify` 最后输出 `[VERIFY] ALL PASS <秒数>s`；失败会给出可单独复现的命令。

## 源码证据

- 工具链与统一命令：[package.json](/source/package.json.txt)
- 只读素材、Range 与隔离响应头：[apps/editor/vite.config.ts](/source/apps/editor/vite.config.ts.txt)
- 能力检测：[apps/editor/src/capabilities.ts](/source/apps/editor/src/capabilities.ts.txt)
- 全量验证编排：[scripts/verify.mjs](/source/scripts/verify.mjs.txt)
- 核心浏览器流程：[apps/editor/e2e/task12-core.spec.ts](/source/apps/editor/e2e/task12-core.spec.ts.txt)

下一步进入[功能导览与目录](/guide/tour)。
