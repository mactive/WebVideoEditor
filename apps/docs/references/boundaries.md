# 参考实践与本 Demo 边界

本章只基于各项目公开仓库/文档和本仓库依赖事实。除 Mediabunny 外，下列项目均未被安装、
复制或运行，因此不把其 README 声明当成本 Demo 的实测结论，也不比较固定性能倍数。

| 项目与来源                                                                                                 | 可借鉴问题                               | 本 Demo 的实际选择                                        | 明确未采用                                           |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| [Mediabunny](https://github.com/Vanilagy/mediabunny) / [文档](https://mediabunny.dev/)                     | 浏览器流式 I/O、容器、sample/packet、Mux | 固定 `1.53.0`，用于 Probe、Demux、sample、MP4 Output      | 不把其官网 benchmark 转述为本机结论                  |
| [WebAV](https://github.com/WebAV-Tech/WebAV)                                                               | WebCodecs 上的 Clip/组合 SDK 抽象        | 参考“浏览器原生编辑 SDK”问题域；本仓库自己定义 Domain/ECS | 未依赖 `av-cliper`，未复制其组合实现                 |
| [OpenReel Video](https://github.com/Augani/openreel-video)                                                 | 完整开源编辑器的产品边界                 | 只作为功能范围参照                                        | 未运行该仓库，不能声称架构或性能等价                 |
| [FreeCut](https://github.com/walterlow/freecut)                                                            | 本地优先时间线、OPFS、WebCodecs          | 参考本地文件/代理/导出的边界问题                          | 本 Demo 仍是单视频轨学习项目，无其多轨/专业功能承诺  |
| [Wazplay README](https://github.com/emdiple/wasplay/blob/main/README.md)                                   | Rust/WASM 模块化媒体处理                 | 本仓库只把波形/时间数学/摘要放 WASM                       | 未采用其 Rust 容器/渲染实现；仓库 URL 名为 `wasplay` |
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) / [FAQ](https://ffmpegwasm.netlify.app/docs/faq/) | 浏览器端 FFmpeg、格式兜底                | 仅保留为未来不兼容格式的候选边界                          | 不进入 Probe/Proxy/Preview/Export 主路径             |
| [WebCodecs 标准](https://w3c.github.io/webcodecs/)                                                         | codec API 但不保证具体 codec             | 每次调用 `isConfigSupported`                              | 不以“有 WebCodecs”推断 H.264/AAC 必然可用            |

## 为什么主路径不是 FFmpeg/WASM

当前固定测试集是浏览器可探测的 H.264/AAC MP4，主目标是学习 packet/frame 生命周期、
硬件 codec 能力、队列水位和流式 OPFS。Mediabunny + WebCodecs 直接暴露这些边界；
Rust WASM 聚焦确定性 CPU 算法。仓库没有在同素材上运行 FFmpeg/WASM 对照基准，所以只说
“未选入主路径”，不说它固定慢多少。

FFmpeg/WASM 适合作为未来格式兜底时，还需单独评估下载体积、线程与 COOP/COEP、虚拟文件
系统、输入大小、codec/license 和取消清理；不能仅替换一个 import。

## 当前范围核对

```bash
pnpm --filter @web-video-editor/editor build
```

```text
UI: 仍只暴露一个视频轨、对应音频轨、一个文字轨
Console: 主路径 marker 为 [IMPORT]/[DEMUX]/[DECODE]/[EXPORT]
CLI: 构建产物包含 media/export/preview worker 与 media_wasm_bg.wasm
CLI: package.json 依赖包含 mediabunny，不包含 WebAV/OpenReel/FreeCut/Wazplay/ffmpeg.wasm
```

## 源码证据

- 实际依赖清单：[apps/editor/package.json](/source/apps/editor/package.json.txt)
- 媒体运行时依赖：[packages/media-runtime/package.json](/source/packages/media-runtime/package.json.txt)
- Rust WASM 职责：[packages/media-wasm/crate/src/lib.rs](/source/packages/media-wasm/crate/src/lib.rs.txt)
- Mediabunny 主路径：[packages/media-runtime/src/probe.ts](/source/packages/media-runtime/src/probe.ts.txt)
- WebCodecs 导出：[apps/editor/src/export/export-pipeline.ts](/source/apps/editor/src/export/export-pipeline.ts.txt)
- 产品范围规格：[.trae/specs/build-web-video-editor-learning-demo/spec.md](/source/.trae/specs/build-web-video-editor-learning-demo/spec.md.txt)
