/// <reference lib="webworker" />

import {
  getOpfsProxyFile,
  MediabunnyDecoderQueueAdapter,
  type DecoderQueueTaskHandle,
} from "@web-video-editor/media-runtime";
import {
  PREVIEW_DECODE_PROTOCOL_VERSION,
  type PreviewDecodeCancel,
  type PreviewDecodeRequest,
  type PreviewDecodeResponse,
} from "@web-video-editor/preview-runtime";
import {
  StructuredLogger,
  WorkerLogSink,
  type LogSink,
  type WorkerMessageTarget,
} from "@web-video-editor/observability";
import {
  ALL_FORMATS,
  BlobSource,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputVideoTrack,
  type VideoSample,
} from "mediabunny";

type ProxyDecoder = {
  input: Input;
  track: InputVideoTrack;
};

const endpoint = self as unknown as DedicatedWorkerGlobalScope &
  WorkerMessageTarget;
let diagnosticLogsEnabled = true;
const workerLogSink = new WorkerLogSink(endpoint);
const gatedLogSink: LogSink = {
  write(entry) {
    if (diagnosticLogsEnabled) {
      workerLogSink.write(entry);
    }
  },
};
const logger = new StructuredLogger(gatedLogSink, "preview-decoder-worker");
const decoders = new Map<string, Promise<ProxyDecoder>>();
const cancelled = new Set<string>();
const decodeTasks = new Map<string, DecoderQueueTaskHandle<void>>();
const decoderQueue = new MediabunnyDecoderQueueAdapter("VideoDecoder", {
  concurrency: 1,
  highWatermark: 8,
  logger,
  overflowPolicy: "replace-oldest",
});
let latestRequestId = "";
const DIRECT_SOURCE_LOOKBACK_US = 2_000_000;

function post(message: PreviewDecodeResponse, transfer: Transferable[] = []) {
  endpoint.postMessage(message, transfer);
}

function queueFields() {
  const decoderQueueStats = decoderQueue.stats();
  return {
    decodeQueue: decoderQueueStats.applicationQueue.queued,
    decoderQueue: decoderQueueStats,
  };
}

function requestKey(requestId: string, entityId: string): string {
  return `${requestId}::${entityId}`;
}

function nearestKeyframeUs(request: PreviewDecodeRequest): number {
  if (request.keyframes.length === 0) {
    return Math.max(0, request.sourceTimeUs - DIRECT_SOURCE_LOOKBACK_US);
  }
  let timestampUs = 0;
  for (const keyframe of request.keyframes) {
    const candidateUs = Math.round(keyframe.timestampSec * 1_000_000);
    if (candidateUs > request.sourceTimeUs) {
      break;
    }
    timestampUs = candidateUs;
  }
  return timestampUs;
}

async function decoderFor(
  cacheKey: string,
  mediaUrl?: string,
): Promise<ProxyDecoder> {
  const decoderKey = mediaUrl ?? cacheKey;
  let decoder = decoders.get(decoderKey);
  if (!decoder) {
    decoder = (async () => {
      const input = new Input({
        formats: ALL_FORMATS,
        source: mediaUrl
          ? new UrlSource(mediaUrl, {
              maxCacheSize: 16 * 1024 * 1024,
              parallelism: 2,
            })
          : new BlobSource(await getOpfsProxyFile(cacheKey, "proxy.mp4"), {
              maxCacheSize: 16 * 1024 * 1024,
            }),
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        input.dispose();
        throw new Error("Cached proxy has no video track");
      }
      return { input, track };
    })();
    decoders.set(decoderKey, decoder);
  }
  return decoder;
}

function isObsolete(
  request: Pick<PreviewDecodeRequest, "entityId" | "requestId">,
  signal?: AbortSignal,
): boolean {
  return (
    signal?.aborted === true ||
    cancelled.has(requestKey(request.requestId, request.entityId)) ||
    request.requestId !== latestRequestId
  );
}

async function sampleAt(
  request: PreviewDecodeRequest,
  track: InputVideoTrack,
  decodeFromUs: number,
  signal: AbortSignal,
): Promise<VideoSample | null> {
  const sink = new VideoSampleSink(track);
  const targetSec = request.sourceTimeUs / 1_000_000;
  const endSec = targetSec + 1 / request.frameRate;
  let selected: VideoSample | null = null;
  for await (const sample of sink.samples(decodeFromUs / 1_000_000, endSec)) {
    if (sample.timestamp <= targetSec + 1 / request.frameRate) {
      selected?.close();
      selected = sample;
    } else {
      sample.close();
    }
    if (isObsolete(request, signal)) {
      selected?.close();
      return null;
    }
  }
  return selected;
}

async function decode(
  request: PreviewDecodeRequest,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = performance.now();
  const decodeFromUs = nearestKeyframeUs(request);
  if (request.diagnosticLogs) {
    logger.log({
      event: "request",
      input: {
        decodeFromUs,
        entityId: request.entityId,
        sourceTimeUs: request.sourceTimeUs,
      },
      level: "debug",
      marker: "[SEEK]",
      projectRevision: request.projectRevision,
      requestId: request.requestId,
    });
    logger.log({
      event: "packet",
      input: { keyframeTimestampUs: decodeFromUs },
      level: "debug",
      marker: "[DEMUX]",
      output: { cacheKey: request.cacheKey },
      projectRevision: request.projectRevision,
      requestId: request.requestId,
    });
  }

  try {
    const { track } = await decoderFor(request.cacheKey, request.mediaUrl);
    const sample = await sampleAt(request, track, decodeFromUs, signal);
    if (!sample || isObsolete(request, signal)) {
      sample?.close();
      post({
        entityId: request.entityId,
        ...queueFields(),
        reason: cancelled.has(requestKey(request.requestId, request.entityId))
          ? "cancelled"
          : "superseded",
        requestId: request.requestId,
        type: "preview.dropped",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      });
      if (request.diagnosticLogs) {
        logger.log({
          event: "frame.dropped",
          input: {
            entityId: request.entityId,
            sourceTimeUs: request.sourceTimeUs,
          },
          level: "debug",
          marker: "[DECODE]",
          output: { reason: "superseded" },
          projectRevision: request.projectRevision,
          requestId: request.requestId,
        });
      }
      return;
    }

    const sourceTimeUs = sample.microsecondTimestamp;
    const frame = sample.toVideoFrame();
    const frameHeight = frame.displayHeight;
    const frameWidth = frame.displayWidth;
    sample.close();
    if (isObsolete(request, signal)) {
      frame.close();
      post({
        entityId: request.entityId,
        ...queueFields(),
        reason: "superseded",
        requestId: request.requestId,
        type: "preview.dropped",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      });
      return;
    }
    post(
      {
        decodeFromUs,
        entityId: request.entityId,
        ...queueFields(),
        frame,
        generation: request.generation,
        projectRevision: request.projectRevision,
        requestId: request.requestId,
        requestedSourceTimeUs: request.sourceTimeUs,
        sourceTimeUs,
        type: "preview.frame",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      },
      [frame],
    );
    if (request.diagnosticLogs) {
      logger.log({
        durationMs: performance.now() - startedAt,
        event: "frame",
        input: { decodeFromUs, sourceTimeUs: request.sourceTimeUs },
        level: "debug",
        marker: "[DECODE]",
        output: {
          ...queueFields(),
          height: frameHeight,
          width: frameWidth,
        },
        projectRevision: request.projectRevision,
        requestId: request.requestId,
      });
    }
  } catch (error) {
    post({
      entityId: request.entityId,
      ...queueFields(),
      error: error instanceof Error ? error.message : String(error),
      projectRevision: request.projectRevision,
      requestId: request.requestId,
      type: "preview.error",
      version: PREVIEW_DECODE_PROTOCOL_VERSION,
    });
    if (request.diagnosticLogs) {
      logger.log({
        error,
        event: "failed",
        input: {
          cacheKey: request.cacheKey,
          sourceTimeUs: request.sourceTimeUs,
        },
        level: "error",
        marker: "[DECODE]",
        projectRevision: request.projectRevision,
        requestId: request.requestId,
      });
    }
  } finally {
    cancelled.delete(requestKey(request.requestId, request.entityId));
  }
}

endpoint.addEventListener(
  "message",
  (event: MessageEvent<PreviewDecodeCancel | PreviewDecodeRequest>) => {
    const request = event.data;
    if (
      request.version !== PREVIEW_DECODE_PROTOCOL_VERSION ||
      request.type !== "preview.request"
    ) {
      return;
    }
    if (request.operation === "cancel") {
      const key = requestKey(request.requestId, request.entityId);
      cancelled.add(key);
      decodeTasks
        .get(key)
        ?.cancel(request.reason ?? "Preview decode cancelled");
      return;
    }
    diagnosticLogsEnabled = request.diagnosticLogs;
    latestRequestId = request.requestId;
    const key = requestKey(request.requestId, request.entityId);
    const task = decoderQueue.schedule(key, (signal) =>
      decode(request, signal),
    );
    decodeTasks.set(key, task);
    void task.result
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          post({
            entityId: request.entityId,
            ...queueFields(),
            reason: cancelled.has(key)
              ? "cancelled"
              : "superseded",
            requestId: request.requestId,
            type: "preview.dropped",
            version: PREVIEW_DECODE_PROTOCOL_VERSION,
          });
          return;
        }
        throw error;
      })
      .finally(() => {
        if (decodeTasks.get(key) === task) {
          decodeTasks.delete(key);
        }
        post({
          entityId: request.entityId,
          ...queueFields(),
          requestId: request.requestId,
          type: "preview.queue",
          version: PREVIEW_DECODE_PROTOCOL_VERSION,
        });
      });
  },
);
