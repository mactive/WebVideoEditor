/// <reference lib="webworker" />

import {
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
  type WorkerMessageTarget,
} from "@web-video-editor/observability";
import {
  ALL_FORMATS,
  Input,
  UrlSource,
  VideoSampleSink,
  type InputVideoTrack,
} from "mediabunny";

type UrlDecoder = {
  input: Input;
  track: InputVideoTrack;
};

const endpoint = self as unknown as DedicatedWorkerGlobalScope &
  WorkerMessageTarget;
const logger = new StructuredLogger(
  new WorkerLogSink(endpoint),
  "sync-video-worker",
);
const decoders = new Map<string, Promise<UrlDecoder>>();
const cancelled = new Set<string>();
const decodeTasks = new Map<string, DecoderQueueTaskHandle<void>>();
const decoderQueue = new MediabunnyDecoderQueueAdapter("VideoDecoder", {
  concurrency: 1,
  highWatermark: 1,
  logger,
  overflowPolicy: "replace-oldest",
});
let latestRequestId = "";

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

async function decoderFor(url: string): Promise<UrlDecoder> {
  let decoder = decoders.get(url);
  if (!decoder) {
    decoder = (async () => {
      const input = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(url, {
          maxCacheSize: 16 * 1024 * 1024,
          parallelism: 2,
        }),
      });
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        input.dispose();
        throw new Error("Test asset has no primary video track");
      }
      return { input, track };
    })();
    decoders.set(url, decoder);
  }
  return decoder;
}

function obsolete(requestId: string, signal: AbortSignal): boolean {
  return (
    signal.aborted || cancelled.has(requestId) || requestId !== latestRequestId
  );
}

async function decode(
  request: PreviewDecodeRequest,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (!request.mediaUrl) {
      throw new Error("Sync debug decoding requires a media URL");
    }
    const { track } = await decoderFor(request.mediaUrl);
    const sample = await new VideoSampleSink(track, {
      optimizeForLatency: true,
    }).getSample(request.sourceTimeUs / 1_000_000);
    if (!sample || obsolete(request.requestId, signal)) {
      sample?.close();
      post({
        ...queueFields(),
        reason: cancelled.has(request.requestId) ? "cancelled" : "superseded",
        requestId: request.requestId,
        type: "preview.dropped",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      });
      return;
    }
    const sourceTimeUs = sample.microsecondTimestamp;
    const frame = sample.toVideoFrame();
    sample.close();
    if (obsolete(request.requestId, signal)) {
      frame.close();
      post({
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
        decodeFromUs: sourceTimeUs,
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
  } catch (error) {
    post({
      ...queueFields(),
      error: error instanceof Error ? error.message : String(error),
      projectRevision: request.projectRevision,
      requestId: request.requestId,
      type: "preview.error",
      version: PREVIEW_DECODE_PROTOCOL_VERSION,
    });
    logger.log({
      error,
      event: "failed",
      input: {
        mediaUrl: request.mediaUrl,
        sourceTimeUs: request.sourceTimeUs,
      },
      level: "error",
      marker: "[DECODE]",
      projectRevision: request.projectRevision,
      requestId: request.requestId,
    });
  } finally {
    cancelled.delete(request.requestId);
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
      cancelled.add(request.requestId);
      decodeTasks
        .get(request.requestId)
        ?.cancel(request.reason ?? "Sync decode cancelled");
      return;
    }
    latestRequestId = request.requestId;
    const task = decoderQueue.schedule(request.requestId, (signal) =>
      decode(request, signal),
    );
    decodeTasks.set(request.requestId, task);
    void task.result
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          post({
            ...queueFields(),
            reason: cancelled.has(request.requestId)
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
        if (decodeTasks.get(request.requestId) === task) {
          decodeTasks.delete(request.requestId);
        }
        post({
          ...queueFields(),
          requestId: request.requestId,
          type: "preview.queue",
          version: PREVIEW_DECODE_PROTOCOL_VERSION,
        });
      });
  },
);
