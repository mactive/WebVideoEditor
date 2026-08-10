# 总体架构与线程图

## 所有权分层

```mermaid
flowchart LR
  subgraph Main["主线程"]
    UI["React UI"]
    CMD["Command Bus"]
    REDUX["Redux\nProject + Session"]
    RX["RxJS Scheduler"]
    ECS["Miniplex ECS"]
    PIXI["PixiJS Scene Graph"]
    CANVAS["Canvas"]
  end
  subgraph Media["Media Worker"]
    PROBE["Mediabunny Probe"]
    PROXY["Proxy / Thumbnail"]
    WASM["Rust WASM Waveform"]
    CACHE["OPFS Cache"]
  end
  subgraph Preview["Preview Worker"]
    DEMUX["Mediabunny Demux"]
    DECODE["WebCodecs Decode"]
  end
  subgraph Export["Export Worker"]
    SOURCE["Original Source"]
    COMPOSE["ECS + OffscreenCanvas"]
    ENCODE["WebCodecs Encode"]
    MUX["Mediabunny MP4 Mux"]
    OUT["OPFS Output"]
  end

  UI --> CMD --> REDUX
  REDUX --> ECS --> PIXI --> CANVAS
  UI --> RX --> PROBE
  PROBE --> PROXY --> WASM --> CACHE
  RX --> DEMUX --> DECODE
  DECODE -->|"VideoFrame transferable"| PIXI
  REDUX --> SOURCE --> COMPOSE --> ENCODE --> MUX --> OUT
```

Project Document 是纯 JSON 唯一事实来源；运行时对象按 revision 编译。代理和大文件属于
Worker/OPFS，`VideoFrame` 属于预览运行时，Pixi 节点属于主线程渲染器，最终文件属于
Export Worker 的 OPFS 目录。

## 一次 Seek 的线程时序

```mermaid
sequenceDiagram
  participant U as UI
  participant R as RxJS switchMap
  participant E as ECS Adapter
  participant W as Preview Worker
  participant P as PixiJS

  U->>E: evaluate(revision, playheadUs)
  E-->>U: assetId + sourceTimeUs
  U->>R: DecodeJob(requestId)
  R->>W: preview.request
  Note over R,W: 新 Seek 会 Abort 旧订阅
  W->>W: 从关键帧 Demux / Decode
  W-->>R: VideoFrame + generation
  R->>R: 检查 requestId/revision/generation/timestamp
  R->>P: present(frame)
  P-->>R: render complete
  R->>R: frame.close()
```

实际边界很重要：预览解码在 `preview.worker.ts`，但 PixiJS 和 Canvas 呈现在主线程；
导出则在 `export.worker.ts` 内用 `OffscreenCanvas` 合成。不能把“支持 OffscreenCanvas”
误写成“正式预览完全离开主线程”。

## 复现与预期输出

```bash
pnpm test:e2e:core
```

```text
UI: 快速连续 Seek 后 presentedPlayheadUs 等于最后一个输入
UI: Decode Queue 0，VideoFrame active 0
Console: 同一 preview-seek-* 可见 [ECS] evaluate、[DEMUX]、[DECODE]、[RENDER]
CLI: 1 passed（耗时随机器变化）
```

## 源码证据

- 主线程装配：[apps/editor/src/App.tsx](/source/apps/editor/src/App.tsx.txt)
- 预览运行时与 RxJS Seek：[packages/preview-runtime/src/preview-runtime.ts](/source/packages/preview-runtime/src/preview-runtime.ts.txt)
- 预览 Worker：[apps/editor/src/preview/preview.worker.ts](/source/apps/editor/src/preview/preview.worker.ts.txt)
- 导出 Worker：[apps/editor/src/export/export.worker.ts](/source/apps/editor/src/export/export.worker.ts.txt)
- 资源所有权计数：[packages/media-runtime/src/lifecycle.ts](/source/packages/media-runtime/src/lifecycle.ts.txt)
