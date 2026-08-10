# WebEditorSketch 项目框架结构图

本文用 Mermaid 描述整个学习型 Web 视频编辑器 Demo 的架构。核心边界是：`Project Document` 保持纯 JSON，媒体运行对象和二进制资源留在 Runtime、Worker、OPFS、WebCodecs 和 PixiJS 所在层。

## 1. 总体架构

```mermaid
flowchart LR
  USER["用户操作<br/>导入 / 编辑 / 预览 / 导出"]

  subgraph Main["主线程：Editor App"]
    UI["React UI<br/>Media / Timeline / Inspector / Preview / Export / Logs"]
    CMD["Command Bus<br/>事务 / Undo / Redo / revision"]
    STORE["Redux Toolkit<br/>Project Document + Editor Session"]
    RX["RxJS Scheduler<br/>取消 / 背压 / 并发 / 进度"]
    ECS["Miniplex ECS<br/>timeline -> animation -> transform -> video -> effect -> render"]
    PIXI["PixiJS v8<br/>Scene Graph / Text / Filter / Canvas"]
    LOGUI["Log Panel<br/>结构化日志展示"]
  end

  subgraph MediaWorker["Media Worker：导入与代理"]
    PROBE["Mediabunny Probe<br/>BlobSource / UrlSource / CustomSource"]
    TRACK["主轨选择<br/>排除封面轨 / 元数据归一化"]
    PROXY["Proxy Pipeline<br/>低分辨率 MP4 / 缩略图 / 关键帧"]
    WASM["Rust WASM<br/>时间换算 / PCM 波形 / 摘要"]
    OPFS_CACHE["OPFS Cache<br/>proxy / thumbnail / waveform manifest"]
  end

  subgraph PreviewWorker["Preview Worker：低分辨率预览解码"]
    PDEMUX["Mediabunny Demux<br/>按 sourceTime 取样"]
    PDEC["WebCodecs Decode<br/>VideoFrame / AudioData"]
    PQUEUE["Decode Queue Metrics<br/>in-flight / HWM / stale"]
  end

  subgraph ExportWorker["Export Worker：高质量导出"]
    ESOURCE["Original Source<br/>File / Blob / URL"]
    EECS["Export Runtime Adapter<br/>复用 ECS 语义"]
    COMPOSE["OffscreenCanvas 2D<br/>原素材帧 + 标题 + 变换 + 滤镜"]
    ENCODE["WebCodecs Encode<br/>H.264 / AAC"]
    MUX["Mediabunny MP4 Mux<br/>fragmented MP4"]
    OPFS_OUT["OPFS Output<br/>tmp -> final mp4"]
  end

  subgraph Persist["持久化与可观察性"]
    IDB["IndexedDB<br/>Project JSON"]
    OBS["packages/observability<br/>日志 schema / marker / sinks"]
    DOCS["VitePress Docs<br/>架构 / 管线 / 测试说明"]
  end

  USER --> UI
  UI --> CMD
  CMD --> STORE
  STORE --> IDB
  UI --> RX
  RX --> PROBE
  PROBE --> TRACK
  TRACK --> PROXY
  PROXY --> WASM
  PROXY --> OPFS_CACHE
  WASM --> OPFS_CACHE
  STORE --> ECS
  ECS --> PIXI
  OPFS_CACHE --> PDEMUX
  RX --> PDEMUX
  PDEMUX --> PDEC
  PDEC --> PQUEUE
  PDEC -->|"Transfer VideoFrame"| PIXI
  PIXI -->|"present()"| UI
  STORE --> EECS
  ESOURCE --> EECS
  EECS --> COMPOSE
  COMPOSE --> ENCODE
  ENCODE --> MUX
  MUX --> OPFS_OUT
  OBS --> LOGUI
  UI --> OBS
  CMD --> OBS
  PROXY --> OBS
  PDEC --> OBS
  ENCODE --> OBS
  OBS --> DOCS
```

## 2. Monorepo 模块依赖

```mermaid
flowchart TD
  ROOT["WebEditorSketch<br/>pnpm workspace"]

  subgraph Apps["apps"]
    EDITOR["apps/editor<br/>React 编辑器"]
    DOCAPP["apps/docs<br/>VitePress 文档站"]
  end

  subgraph Packages["packages"]
    DOMAIN["packages/domain<br/>Project schema / commands / migration"]
    MEDIA["packages/media-runtime<br/>Mediabunny / RxJS / Worker 协议 / OPFS"]
    WASMPKG["packages/media-wasm<br/>Rust crate + wasm-bindgen 包装"]
    PREVIEW["packages/preview-runtime<br/>ECS / Runtime Adapter / Pixi renderer"]
    OBSERV["packages/observability<br/>日志 schema / marker / sinks"]
    CONFIG["packages/config<br/>共享 TypeScript / lint / test 配置"]
  end

  subgraph Other["辅助目录"]
    SCRIPTS["scripts<br/>verify / docs source generation / probe"]
    ASSETS["test_assets<br/>固定测试素材"]
    SPEC[".trae/specs<br/>spec / tasks / checklist"]
    AGENT["Agent.md<br/>技术方案与验证手册"]
  end

  ROOT --> EDITOR
  ROOT --> DOCAPP
  ROOT --> DOMAIN
  ROOT --> MEDIA
  ROOT --> WASMPKG
  ROOT --> PREVIEW
  ROOT --> OBSERV
  ROOT --> CONFIG
  ROOT --> SCRIPTS
  ROOT --> ASSETS
  ROOT --> SPEC
  ROOT --> AGENT

  EDITOR --> DOMAIN
  EDITOR --> MEDIA
  EDITOR --> WASMPKG
  EDITOR --> PREVIEW
  EDITOR --> OBSERV
  DOCAPP --> OBSERV
  MEDIA --> WASMPKG
  MEDIA --> OBSERV
  PREVIEW --> DOMAIN
  PREVIEW --> MEDIA
  PREVIEW --> OBSERV
  SCRIPTS --> MEDIA
```

## 3. 导入、代理与预览管线

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant UI as React UI
  participant CB as Command Bus
  participant S as Redux Store
  participant Q as RxJS / BoundedTaskQueue
  participant MW as Media Worker
  participant OPFS as OPFS Cache
  participant PW as Preview Worker
  participant PIXI as PixiJS Renderer

  U->>UI: 选择 test_assets 或本地 File
  UI->>Q: submitImport(fileOrUrl)
  Q->>MW: probe(source)
  MW->>MW: Mediabunny 读取元数据并选择主轨
  MW-->>UI: asset metadata + capability + probe logs
  UI->>CB: addAsset / addClip
  CB->>S: 写入纯 JSON Project Document
  Q->>MW: generateProxy(assetId)
  MW->>MW: 低分辨率转码 / 缩略图 / 关键帧
  MW->>MW: Rust WASM 计算 PCM 波形
  MW->>OPFS: commit proxy manifest
  MW-->>UI: proxyReady(cacheKey)
  U->>UI: 播放或 Seek
  UI->>S: 读取 playhead + revision
  UI->>PW: requestFrame(assetId, sourceTimeUs, generation)
  PW->>OPFS: 读取 proxy 或按需 source
  PW->>PW: Mediabunny Demux + WebCodecs Decode
  PW-->>PIXI: Transfer VideoFrame
  PIXI->>PIXI: draw frame / text / filter / transform
  PIXI-->>UI: presentedFrames + render metrics
```

## 4. 编辑与状态所有权

```mermaid
flowchart LR
  subgraph PureState["可序列化状态"]
    PROJECT["Project Document<br/>asset / track / clip / title / effect / exportSettings"]
    SESSION["Editor Session<br/>selection / zoom / playhead / panel state"]
    HISTORY["Command History<br/>undoStack / redoStack / transaction"]
    SNAPSHOT["IndexedDB Snapshot<br/>Project JSON"]
  end

  subgraph RuntimeState["运行时对象"]
    FILES["File / Blob / URL Handle"]
    BUFFERS["ArrayBuffer / TypedArray / PCM"]
    CODECS["VideoDecoder / AudioDecoder / VideoEncoder / AudioEncoder"]
    FRAMES["VideoFrame / AudioData"]
    PIXIOBJ["Pixi Sprite / Text / Texture"]
    WORKERS["Media / Preview / Export Workers"]
    OPFSFILES["OPFS proxy / tmp / output"]
  end

  UIEDIT["UI 编辑动作"] --> COMMAND["Command"]
  COMMAND --> INVARIANT["Zod schema<br/>引用完整性 / 非重叠约束"]
  INVARIANT --> PROJECT
  COMMAND --> HISTORY
  PROJECT --> SNAPSHOT
  SESSION --> SNAPSHOT
  PROJECT -->|"revision 编译"| WORKERS
  PROJECT -->|"revision 编译"| PIXIOBJ
  WORKERS -->|"metrics / logs only"| SESSION
  FRAMES -->|"metrics / logs only"| SESSION
  OPFSFILES -->|"metrics / logs only"| SESSION

  FILES -. "禁止写入 Redux" .-> PROJECT
  BUFFERS -. "禁止转普通 Number 数组长期保存" .-> PROJECT
  CODECS -. "取消或结束后释放" .-> PROJECT
  FRAMES -. "消费后 close()" .-> PROJECT
  PIXIOBJ -. "不反向写入 Project" .-> PROJECT
  WORKERS -. "只通过协议通信" .-> PROJECT
```

## 5. 高质量导出管线

```mermaid
flowchart LR
  PROJECT["Project revision<br/>JSON timeline"]
  ORIGINAL["Original Source<br/>File / Blob / URL"]
  CAP["Capability Check<br/>VideoEncoder.isConfigSupported<br/>AudioEncoder.isConfigSupported"]
  RUNTIME["ProjectRuntimeAdapter<br/>export profile"]
  VIDEO_SAMPLE["Mediabunny VideoSample<br/>source time"]
  AUDIO_SAMPLE["Mediabunny AudioSample<br/>trim / resample"]
  CANVAS["OffscreenCanvas<br/>1920x1080 或工程设置"]
  FRAME["VideoFrame<br/>close after encode"]
  ADATA["AudioData<br/>close after encode"]
  VENC["VideoEncoder<br/>H.264"]
  AENC["AudioEncoder<br/>AAC"]
  PACKETS["EncodedPacket"]
  MP4["Mediabunny Output<br/>MP4 Mux"]
  FINAL["OPFS final file<br/>export-requestId.mp4"]

  PROJECT --> CAP
  ORIGINAL --> CAP
  CAP --> RUNTIME
  PROJECT --> RUNTIME
  ORIGINAL --> VIDEO_SAMPLE
  ORIGINAL --> AUDIO_SAMPLE
  RUNTIME --> CANVAS
  VIDEO_SAMPLE --> CANVAS
  CANVAS --> FRAME
  FRAME --> VENC
  AUDIO_SAMPLE --> ADATA
  ADATA --> AENC
  VENC --> PACKETS
  AENC --> PACKETS
  PACKETS --> MP4
  MP4 --> FINAL

  PROXY_NOTE["proxy 只服务预览<br/>禁止作为导出源"] -. "must not use" .-> ORIGINAL
```

## 6. 日志、验证与文档反馈闭环

```mermaid
flowchart TD
  CODE["源码变更"]
  LOGS["结构化日志<br/>[CAPABILITY] [COMMAND] [IMPORT] [PROXY] [SEEK] [DEMUX] [DECODE] [WASM] [ECS] [RENDER] [EXPORT]"]
  UNIT["Vitest<br/>domain / runtime / preview"]
  WASMTEST["Rust fmt / clippy / test<br/>wasm browser test"]
  E2E["Playwright<br/>导入 / 代理 / 预览 / 编辑 / 导出"]
  BUILD["pnpm build<br/>editor + docs"]
  VERIFY["pnpm verify<br/>统一验证入口"]
  DOCS["apps/docs<br/>架构和管线说明"]
  AGENTMD["Agent.md<br/>长期维护指南"]
  ARCHMD["arch.md<br/>当前架构图"]

  CODE --> LOGS
  CODE --> UNIT
  CODE --> WASMTEST
  CODE --> E2E
  CODE --> BUILD
  UNIT --> VERIFY
  WASMTEST --> VERIFY
  E2E --> VERIFY
  BUILD --> VERIFY
  LOGS --> DOCS
  VERIFY --> DOCS
  DOCS --> AGENTMD
  DOCS --> ARCHMD
```
