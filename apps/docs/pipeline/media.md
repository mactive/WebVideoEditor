# Mediabunny、WebCodecs：Demux / Decode / Encode / Mux

容器和 codec 是两层：Mediabunny 识别 MP4、按需读取 packet/sample，并组织 Output；
WebCodecs（直接或经 Mediabunny sample API）负责硬件优先的帧/音频编解码。
MP4 容器本身的 box、`moov`、sample table 和流式播放细节见
[MP4 文件格式详解](/pipeline/mp4-format)。

```mermaid
flowchart LR
  FILE["File / URL / OPFS"] --> SOURCE["BlobSource / UrlSource"]
  SOURCE --> INPUT["Mediabunny Input"]
  INPUT --> TRACK["主音视频轨选择"]
  TRACK --> PACKET["Demux packet"]
  PACKET --> DECODER["WebCodecs Decoder"]
  DECODER --> SAMPLE["VideoFrame / AudioData"]
  SAMPLE --> COMPOSE["PixiJS 或 OffscreenCanvas"]
  COMPOSE --> ENCODER["WebCodecs Encoder"]
  ENCODER --> EP["EncodedPacket"]
  EP --> OUTPUT["Mediabunny MP4 Output"]
  OUTPUT --> STREAM["StreamTarget -> OPFS"]
```

## 导入与主轨

探测使用 `CustomSource`（CLI）、`BlobSource` 或 `UrlSource`，统计每次 read 区间。主视频轨
优先排除存在正常视频轨时的 MJPEG 附加轨，再按帧率/packet 数、primary/default、
分辨率、时长排序。`test_1`、`test_2` 的 JPEG cover art 会进入 excludedVideoTracks。

## 预览解码

Preview Worker 根据关键帧索引选择 `decodeFromUs`，由 Mediabunny `VideoSampleSink` 解码
目标附近帧并把 VideoFrame 发送主线程。主线程检查 revision/generation/timestamp 后呈现
并关闭。decodeQueue 是协议指标，过期结果绝不覆盖最新 Seek。

## 代理与导出编码

代理通过 `VideoSampleSource(codec: "avc")`、`AudioSampleSource(codec: "aac")` 转码，
Mediabunny 内部适配 WebCodecs。最终导出则直接创建 `VideoEncoder`/`AudioEncoder`，
将 EncodedChunk 转成 Mediabunny EncodedPacket 后流式 Mux。导出前真实执行
`isConfigSupported`；不支持时阻止任务。

## 复现与预期输出

```bash
pnpm media:probe -- test_assets/test_1.mp4
```

```text
CLI: [PROBE] metadata
CLI: [PROBE] main-track.selected（video=AVC High 720x720，audio=AAC LC）
CLI: [PROBE] summary（excludedVideoTracks 含 jpeg-cover-art）
UI: 素材卡显示 AVC High、AAC LC、UrlSource、按需读取字节
Console: [DEMUX] packet -> [DECODE] frame -> [RENDER] present
```

## 源码证据

- Mediabunny 探测与主轨选择：[packages/media-runtime/src/probe.ts](/source/packages/media-runtime/src/probe.ts.txt)
- Node CustomSource：[packages/media-runtime/src/probe-node.ts](/source/packages/media-runtime/src/probe-node.ts.txt)
- Preview Worker Demux/Decode：[apps/editor/src/preview/preview.worker.ts](/source/apps/editor/src/preview/preview.worker.ts.txt)
- 代理 Decode/Encode/Mux：[packages/media-runtime/src/proxy-pipeline.ts](/source/packages/media-runtime/src/proxy-pipeline.ts.txt)
- 导出直接 WebCodecs：[apps/editor/src/export/export-pipeline.ts](/source/apps/editor/src/export/export-pipeline.ts.txt)
