# 预览 Worker 解码链路：MP4 sample 到 VideoFrame

这篇文章把预览路径中“Worker 从 MP4 取样并得到 `VideoFrame`”单独拆开。它关注每一层的职责、
输入输出数据结构和所有权边界。

完整路径是：

```text
PreviewRuntime
  -> PreviewDecoderClient.postMessage(JSON request)
  -> preview.worker.ts
  -> Mediabunny Input / Source
  -> InputVideoTrack
  -> VideoSampleSink.samples(...)
  -> VideoSample.toVideoFrame()
  -> postMessage(JSON response + transferable VideoFrame)
  -> PreviewRuntime.present(...)
  -> PixiPreviewRenderer.drawImage(frame)
```

核心结论：

- 主线程发给 Worker 的是**结构化 JSON 请求**，不传 MP4 buffer，也不传 `VideoFrame`。
- Worker 自己从 OPFS proxy 或 URL 源读取 MP4，Mediabunny 负责容器读取、轨道解析和按时间取样。
- `VideoSample` 是 Mediabunny 运行时对象，不进入 Redux、不跨线程保存，消费后必须 `close()`。
- `VideoFrame` 是 WebCodecs 原生对象，通过 `postMessage(..., [frame])` 转移所有权给主线程。
- 主线程如果发现帧过期，会立刻 `frame.close()`；如果呈现成功，也通过 lifecycle lease 释放。

## 1. Runtime 先算出要取哪一帧

预览不是直接按项目时间去解 MP4。`PreviewRuntime` 会先把 Project 当前状态计算成运行时实体，再找出
当前活动视频片段对应的素材时间。

概念结构如下：

```ts
type RuntimeEvaluation = {
  activeEntities: readonly RuntimeEntity[];
  activeVideos: readonly {
    assetId: string;
    entityId: string;
    order: number;
    sourceTimeUs: number;
  }[];
  playheadUs: number;
  revision: number;
  video?: {
    assetId: string;
    entityId: string;
    sourceTimeUs: number;
  };
};
```

`video` 字段保留为兼容单层调用方的第一个 active video；多视频轨道实际消费
`activeVideos`。该数组按轨道 `order` 排序，PreviewRuntime 会为同一 playhead 上的每个
active video entity 发起解码请求，并把 `entityId` 带入 request / response，避免 V1/V2 的
过期帧互相覆盖。

真实例子：

```json
{
  "playheadUs": 12500000,
  "revision": 8,
  "activeVideos": [
    {
      "assetId": "asset-test-2",
      "entityId": "clip:clip-1",
      "order": 0,
      "sourceTimeUs": 12500000
    },
    {
      "assetId": "asset-test-2",
      "entityId": "clip:clip-2",
      "order": 3,
      "sourceTimeUs": 3500000
    }
  ]
}
```

这一层的输出不是媒体数据，而是“每个视频层要向哪个素材取哪个时间点”。随后它会组装一个内部
decode batch：

```ts
type DecodeBatch = {
  generation: number;
  layers: readonly {
    entityId: string;
    source: PreviewSource;
    sourceTimeUs: number;
  }[];
  origin: "seek" | "playback";
  playheadUs: number;
  projectRevision: number;
  requestId: string;
};
```

其中 `generation` 用来隔离播放时钟重置，`projectRevision` 用来隔离项目状态变化，`requestId`
用来隔离连续 seek。一次 batch 内的多层共享同一个 requestId/revision/generation，但每层有
独立 `entityId` 和 `sourceTimeUs`。

## 2. PreviewSource 描述素材入口

`PreviewSource` 有两种来源：已经生成好的 OPFS proxy，或仍在 fallback 的原始 URL。

```ts
type PreviewSourceBase = {
  assetId: string;
  cacheStatus: ProxyCacheStatus;
  keyframes: readonly ProxyKeyframe[];
};

type PreviewSource =
  | (PreviewSourceBase & {
      manifest: ProxyManifest;
      mediaUrl?: string;
    })
  | (PreviewSourceBase & {
      cacheKey: string;
      frameRate: number;
      height: number;
      mediaUrl: string;
      width: number;
    });
```

proxy 已完成时，关键字段来自 `manifest.proxy`：

```json
{
  "assetId": "asset-test-2",
  "cacheStatus": "hit",
  "manifest": {
    "cacheKey": "proxy-a1b2",
    "proxy": {
      "path": "proxy.mp4",
      "mimeType": "video/mp4",
      "byteLength": 18420331,
      "durationSec": 62.4,
      "frameRate": 30,
      "width": 960,
      "height": 540
    }
  },
  "keyframes": [
    {
      "timestampSec": 10,
      "durationSec": 0.033333,
      "byteLength": 18432,
      "sequenceNumber": 300
    },
    {
      "timestampSec": 12,
      "durationSec": 0.033333,
      "byteLength": 19320,
      "sequenceNumber": 360
    }
  ]
}
```

proxy 未完成或需要直读测试素材时，`mediaUrl` 指向可 Range 读取的 MP4：

```json
{
  "assetId": "asset-test-2",
  "cacheKey": "direct-test-2",
  "cacheStatus": "miss",
  "frameRate": 30,
  "height": 720,
  "keyframes": [],
  "mediaUrl": "/test_assets/test_2.mp4",
  "width": 1280
}
```

## 3. 发给 Worker 的请求是纯 JSON

`PreviewDecoderClient.decode(...)` 把 `PreviewSource` 压缩成 Worker 协议请求：

```ts
type PreviewDecodeRequest = {
  cacheKey: string;
  diagnosticLogs: boolean;
  entityId: string;
  frameRate: number;
  generation: number;
  keyframes: readonly ProxyKeyframe[];
  mediaUrl?: string;
  operation: "decode";
  projectRevision: number;
  requestId: string;
  sourceTimeUs: number;
  type: "preview.request";
  version: 1;
};
```

真实消息例子：

```json
{
  "type": "preview.request",
  "version": 1,
  "operation": "decode",
  "requestId": "preview-seek-42",
  "entityId": "clip:clip-2",
  "projectRevision": 8,
  "generation": 3,
  "cacheKey": "proxy-a1b2",
  "sourceTimeUs": 12500000,
  "frameRate": 30,
  "diagnosticLogs": false,
  "keyframes": [
    {
      "timestampSec": 12,
      "durationSec": 0.033333,
      "byteLength": 19320,
      "sequenceNumber": 360
    }
  ]
}
```

注意这里没有 MP4 字节，也没有 `ArrayBuffer`。Worker 根据 `cacheKey` 或 `mediaUrl` 自己打开源。

取消请求也是纯 JSON：

```ts
type PreviewDecodeCancel = {
  entityId: string;
  operation: "cancel";
  reason?: string;
  requestId: string;
  type: "preview.request";
  version: 1;
};
```

## 4. Worker 选择从哪里开始解

Worker 收到请求后先进入 `MediabunnyDecoderQueueAdapter`。当前预览视频解码队列配置是：

```ts
{
  concurrency: 1,
  highWatermark: 8,
  overflowPolicy: "replace-oldest"
}
```

这意味着连续 seek 时旧任务会被替换，避免队列堆满旧帧。

之后 `nearestKeyframeUs(request)` 计算 `decodeFromUs`：

```ts
function nearestKeyframeUs(request: PreviewDecodeRequest): number {
  if (request.keyframes.length === 0) {
    return Math.max(0, request.sourceTimeUs - 2_000_000);
  }
  let timestampUs = 0;
  for (const keyframe of request.keyframes) {
    const candidateUs = Math.round(keyframe.timestampSec * 1_000_000);
    if (candidateUs > request.sourceTimeUs) break;
    timestampUs = candidateUs;
  }
  return timestampUs;
}
```

例子：

```text
sourceTimeUs = 12_500_000
keyframes    = [0s, 2s, 4s, 6s, 8s, 10s, 12s]
decodeFromUs = 12_000_000
```

如果没有 keyframe manifest，就从目标时间前 2 秒开始找。这是直读原素材 fallback 的保护策略，
避免每次 seek 都从 0 秒扫起。

## 5. Mediabunny Input / Source 负责 MP4 读取

Worker 会按来源创建并缓存一个 `ProxyDecoder`：

```ts
type ProxyDecoder = {
  input: Input;
  track: InputVideoTrack;
};
```

OPFS proxy 路径：

```ts
new Input({
  formats: ALL_FORMATS,
  source: new BlobSource(await getOpfsProxyFile(cacheKey, "proxy.mp4"), {
    maxCacheSize: 16 * 1024 * 1024,
  }),
});
```

这里 `getOpfsProxyFile(cacheKey, "proxy.mp4")` 返回的是 OPFS 里的 `File`。文件形态类似：

```text
File {
  name: "proxy.mp4",
  type: "video/mp4",
  size: 18420331,
  lastModified: 178...
}
```

URL 直读路径：

```ts
new Input({
  formats: ALL_FORMATS,
  source: new UrlSource(mediaUrl, {
    maxCacheSize: 16 * 1024 * 1024,
    parallelism: 2,
  }),
});
```

这一层的职责：

- 识别 MP4 容器和内部 track。
- 按需读取文件或 URL byte range。
- 找到 primary video track。
- 给后续 `VideoSampleSink` 提供可按时间读取的 `InputVideoTrack`。

这一层不会把整个 MP4 放进 Redux，也不会把完整文件 bytes 发回主线程。

## 6. VideoSampleSink 输出 Mediabunny VideoSample

真正按时间取样发生在 `sampleAt(...)`：

```ts
const sink = new VideoSampleSink(track);
const targetSec = request.sourceTimeUs / 1_000_000;
const endSec = targetSec + 1 / request.frameRate;

for await (const sample of sink.samples(decodeFromUs / 1_000_000, endSec)) {
  if (sample.timestamp <= targetSec + 1 / request.frameRate) {
    selected?.close();
    selected = sample;
  } else {
    sample.close();
  }
}
```

`VideoSample` 是 Mediabunny 的运行时对象，不是项目里定义的 JSON。项目实际使用到的字段和方法可以
抽象成：

```ts
type VideoSampleLike = {
  timestamp: number; // 秒
  duration: number; // 秒
  microsecondTimestamp: number; // 微秒
  type?: "key" | "delta";
  byteLength?: number;
  close(): void;
  toVideoFrame(): VideoFrame;
};
```

真实观测形态可以理解为：

```json
{
  "timestamp": 12.5,
  "duration": 0.033333,
  "microsecondTimestamp": 12500000,
  "type": "delta",
  "byteLength": 12876
}
```

这一层只保留目标附近最后一个 sample：

- 如果新 sample 更接近目标时间，旧的 `selected` 会立刻 `close()`。
- 如果请求已经被取消或被更新请求取代，当前 sample 会 `close()` 并返回 `null`。
- 最终拿到的 sample 在 `toVideoFrame()` 后也会立刻 `close()`。

## 7. VideoSample.toVideoFrame 输出 WebCodecs VideoFrame

Worker 得到 sample 后执行：

```ts
const sourceTimeUs = sample.microsecondTimestamp;
const frame = sample.toVideoFrame();
const frameHeight = frame.displayHeight;
const frameWidth = frame.displayWidth;
sample.close();
```

`VideoFrame` 是 WebCodecs 原生对象，常用字段如下：

```ts
type VideoFrameShape = {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  duration: number | null; // 微秒
  timestamp: number; // 微秒
  format: VideoPixelFormat | null; // 例如 "I420"、"NV12"、"RGBA"
  colorSpace: VideoColorSpace;
  allocationSize(options?: VideoFrameCopyToOptions): number;
  copyTo(
    destination: BufferSource,
    options?: VideoFrameCopyToOptions,
  ): Promise<PlaneLayout[]>;
  close(): void;
};
```

真实例子：

```json
{
  "codedWidth": 960,
  "codedHeight": 540,
  "displayWidth": 960,
  "displayHeight": 540,
  "timestamp": 12500000,
  "duration": 33333,
  "format": "NV12",
  "colorSpace": {
    "primaries": "bt709",
    "transfer": "bt709",
    "matrix": "bt709",
    "fullRange": false
  }
}
```

如果需要把 `VideoFrame` 复制成显式 buffer，可走 `allocationSize()` 和 `copyTo()`：

```ts
const bytes = new Uint8Array(frame.allocationSize({ format: "RGBA" }));
const layout = await frame.copyTo(bytes, { format: "RGBA" });
```

`RGBA` buffer 大小约为：

```text
960 * 540 * 4 = 2_073_600 bytes
```

但预览路径不这么做。项目直接把 `VideoFrame` 作为 transferable 传回主线程，避免把每帧复制成
大块 `ArrayBuffer`。

## 8. Worker 返回 JSON envelope + transferable frame

成功时 Worker 发回：

```ts
type PreviewFrameResponse = {
  decodeFromUs: number;
  decodeQueue: number;
  decoderQueue: CodecQueueObservation;
  entityId: string;
  frame: VideoFrame;
  generation: number;
  projectRevision: number;
  requestId: string;
  requestedSourceTimeUs: number;
  sourceTimeUs: number;
  type: "preview.frame";
  version: 1;
};
```

发送方式：

```ts
postMessage(response, [frame]);
```

真实消息 envelope：

```json
{
  "type": "preview.frame",
  "version": 1,
  "requestId": "preview-seek-42",
  "entityId": "clip:clip-2",
  "projectRevision": 8,
  "generation": 3,
  "decodeFromUs": 12000000,
  "requestedSourceTimeUs": 12500000,
  "sourceTimeUs": 12500000,
  "decodeQueue": 0,
  "decoderQueue": {
    "implementation": "mediabunny",
    "codec": "VideoDecoder",
    "applicationQueue": {
      "active": 1,
      "queued": 0,
      "concurrency": 1,
      "highWatermark": 8,
      "activePeak": 1,
      "queuedPeak": 0,
      "backpressureCount": 0
    },
    "internalQueue": {
      "available": false,
      "queueSize": null,
      "highWatermark": null,
      "peak": null,
      "reason": "Mediabunny does not expose its internal WebCodecs decodeQueueSize; only the application scheduler is observable."
    }
  },
  "frame": "[VideoFrame transferable]"
}
```

失败和丢弃则不带 frame：

```ts
type PreviewDroppedResponse = {
  decodeQueue: number;
  decoderQueue: CodecQueueObservation;
  entityId: string;
  reason: "cancelled" | "superseded";
  requestId: string;
  type: "preview.dropped";
  version: 1;
};

type PreviewErrorResponse = {
  decodeQueue: number;
  decoderQueue: CodecQueueObservation;
  entityId: string;
  error: string;
  projectRevision: number;
  requestId: string;
  type: "preview.error";
  version: 1;
};
```

## 9. 主线程接收、校验、呈现、释放

`PreviewDecoderClient` 收到 `preview.frame` 后会先做陈旧帧检查：

```ts
if (
  !pending ||
  requestId !== latestRequestId ||
  response.entityId !== pending.entityId ||
  response.generation !== pending.generation ||
  response.projectRevision !== pending.projectRevision
) {
  response.frame.close();
  staleFrames += 1;
  return;
}
```

通过检查后，主线程用 `ResourceLifecycleTracker` 管理这个 `VideoFrame`：

```ts
const lease = lifecycle.trackClosable("video-frame", response.frame);

pending.resolve({
  decodeFromUs: response.decodeFromUs,
  entityId: response.entityId,
  frame: response.frame,
  release: () => lease.release(),
  requestId,
  requestedSourceTimeUs: response.requestedSourceTimeUs,
  sourceTimeUs: response.sourceTimeUs,
});
```

`PreviewRuntime.present(...)` 里最终会把 frame 交给渲染器：

```ts
renderer.present(decoded.frame, {
  entityId: job.entityId,
  playheadUs: job.playheadUs,
  projectRevision: job.projectRevision,
  requestId: job.requestId,
});
```

无论呈现成功、时间戳落后被丢弃，还是发生重同步，`finally` 都会释放：

```ts
finally {
  decoded.release();
}
```

这条规则很重要：`VideoFrame` 关联浏览器底层解码/GPU 资源，不能依赖 GC 被动回收。

## 10. PixiJS 实际怎么消费 VideoFrame

当前 `PixiPreviewRenderer` 没有直接把 `VideoFrame` 当 Pixi texture 传入，而是先画到中间 canvas：

```ts
const context = frameCanvas.getContext("2d");
context.drawImage(frame, x, y, width, height);
frameSource.update();
application.render();
```

这一层的输入是 `VideoFrame`：

```json
{
  "displayWidth": 960,
  "displayHeight": 540,
  "timestamp": 12500000
}
```

输出是更新后的 Pixi `CanvasSource` / `Texture`，随后和文字层、滤镜、变换一起渲染到预览画布。
这个输出不是 JSON，也不进入 Worker 协议。

## 11. 数据所有权总表

| 阶段              | 输入                          | 输出                       | 是否 JSON | 是否跨线程                    | 释放责任                |
| ----------------- | ----------------------------- | -------------------------- | --------- | ----------------------------- | ----------------------- |
| Runtime evaluate  | Project JSON、playheadUs      | `RuntimeEvaluation`        | 是        | 否                            | 无                      |
| Decode request    | `PreviewSource`、sourceTimeUs | `PreviewDecodeRequest`     | 是        | 主线程 -> Worker              | 无                      |
| Source open       | cacheKey/mediaUrl             | `Input`、`InputVideoTrack` | 否        | 否                            | Worker 缓存到终止       |
| Sample select     | track、decodeFromUs/endSec    | `VideoSample`              | 否        | 否                            | Worker `sample.close()` |
| Frame materialize | `VideoSample`                 | `VideoFrame`               | 否        | Worker -> 主线程 transferable | 主线程 `frame.close()`  |
| Render present    | `VideoFrame`                  | CanvasSource/Texture 更新  | 否        | 否                            | `decoded.release()`     |

## 源码证据

- Worker 请求/响应协议：[packages/preview-runtime/src/decoder.ts](/source/packages/preview-runtime/src/decoder.ts.txt)
- PreviewSource 与运行时类型：[packages/preview-runtime/src/types.ts](/source/packages/preview-runtime/src/types.ts.txt)
- Preview Worker 解码实现：[apps/editor/src/preview/preview.worker.ts](/source/apps/editor/src/preview/preview.worker.ts.txt)
- Preview Runtime 发起和呈现：[packages/preview-runtime/src/preview-runtime.ts](/source/packages/preview-runtime/src/preview-runtime.ts.txt)
- PixiJS 消费 VideoFrame：[packages/preview-runtime/src/pixi-renderer.ts](/source/packages/preview-runtime/src/pixi-renderer.ts.txt)
