import {
  createMediabunnyDecoderQueueObservation,
  type CodecQueueObservation,
  ResourceLifecycleTracker,
  type ResourceLifecycleSnapshot,
  type ResourceLease,
} from "@web-video-editor/media-runtime";
import type { StructuredLogger } from "@web-video-editor/observability";
import {
  WORKER_LOG_MESSAGE_TYPE,
  receiveWorkerLog,
  type LogSink,
} from "@web-video-editor/observability";

import { previewSourceMetadata, type PreviewSource } from "./types";

export const PREVIEW_DECODE_PROTOCOL_VERSION = 1 as const;

export type PreviewDecodeRequest = {
  cacheKey: string;
  generation: number;
  keyframes: PreviewSource["keyframes"];
  frameRate: number;
  mediaUrl?: string;
  operation: "decode";
  projectRevision: number;
  requestId: string;
  sourceTimeUs: number;
  type: "preview.request";
  version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
};

export type PreviewDecodeCancel = {
  operation: "cancel";
  reason?: string;
  requestId: string;
  type: "preview.request";
  version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
};

export type PreviewDecodeResponse =
  | {
      decodeQueue: number;
      decoderQueue: CodecQueueObservation;
      requestId: string;
      type: "preview.queue";
      version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
    }
  | {
      decodeFromUs: number;
      decodeQueue: number;
      decoderQueue: CodecQueueObservation;
      frame: VideoFrame;
      generation: number;
      projectRevision: number;
      requestId: string;
      requestedSourceTimeUs: number;
      sourceTimeUs: number;
      type: "preview.frame";
      version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
    }
  | {
      decodeQueue: number;
      decoderQueue: CodecQueueObservation;
      reason: "cancelled" | "superseded";
      requestId: string;
      type: "preview.dropped";
      version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
    }
  | {
      decodeQueue: number;
      decoderQueue: CodecQueueObservation;
      error: string;
      projectRevision: number;
      requestId: string;
      type: "preview.error";
      version: typeof PREVIEW_DECODE_PROTOCOL_VERSION;
    };

type WorkerTransport = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(message: PreviewDecodeCancel | PreviewDecodeRequest): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  terminate(): void;
};

export type DecodedPreviewFrame = {
  decodeFromUs: number;
  frame: VideoFrame;
  generation: number;
  release(): void;
  requestId: string;
  requestedSourceTimeUs: number;
  sourceTimeUs: number;
};

export type PreviewDecoderStats = {
  decodeQueue: number;
  decoderQueue: CodecQueueObservation;
  droppedFrames: number;
  staleFrames: number;
};

type PendingDecode = {
  abort?: () => void;
  generation: number;
  projectRevision: number;
  reject(reason: unknown): void;
  resolve(value: DecodedPreviewFrame): void;
  signal?: AbortSignal;
};

function abortError(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

export class PreviewDecoderClient {
  private readonly lifecycle: ResourceLifecycleTracker;
  private readonly worker: WorkerTransport;
  private readonly workerLease: ResourceLease;
  private readonly pending = new Map<string, PendingDecode>();
  private readonly statsListeners = new Set<() => void>();
  private latestRequestId?: string;
  private decodeQueue = 0;
  private decoderQueue =
    createMediabunnyDecoderQueueObservation("VideoDecoder");
  private droppedFrames = 0;
  private staleFrames = 0;
  private disposed = false;

  private readonly onMessage = (event: MessageEvent<unknown>) => {
    if (
      this.workerLogSink &&
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === WORKER_LOG_MESSAGE_TYPE
    ) {
      receiveWorkerLog(event.data, this.workerLogSink);
      return;
    }
    const message = event.data as Partial<PreviewDecodeResponse>;
    if (message.version !== PREVIEW_DECODE_PROTOCOL_VERSION) {
      return;
    }
    this.decodeQueue =
      typeof message.decodeQueue === "number" ? message.decodeQueue : 0;
    if (message.decoderQueue) {
      this.decoderQueue = message.decoderQueue;
      this.decodeQueue = message.decoderQueue.applicationQueue.queued;
      this.notifyStats();
    }
    const requestId =
      typeof message.requestId === "string" ? message.requestId : "";
    const pending = this.pending.get(requestId);

    if (message.type === "preview.queue") {
      return;
    }

    if (message.type === "preview.frame") {
      const response = message as Extract<
        PreviewDecodeResponse,
        { type: "preview.frame" }
      >;
      if (
        !pending ||
        requestId !== this.latestRequestId ||
        response.generation !== pending.generation ||
        response.projectRevision !== pending.projectRevision
      ) {
        response.frame.close();
        this.staleFrames += 1;
        this.logger?.log({
          event: "frame.dropped",
          input: {
            incomingGeneration: response.generation,
            incomingRevision: response.projectRevision,
            sourceTimeUs: response.sourceTimeUs,
          },
          level: "debug",
          marker: "[DECODE]",
          output: { reason: "stale-preview-frame" },
          projectRevision: response.projectRevision,
          requestId,
        });
        return;
      }
      this.pending.delete(requestId);
      this.detachAbort(pending);
      const lease = this.lifecycle.trackClosable("video-frame", response.frame);
      pending.resolve({
        decodeFromUs: response.decodeFromUs,
        frame: response.frame,
        generation: response.generation,
        release: () => lease.release(),
        requestId,
        requestedSourceTimeUs: response.requestedSourceTimeUs,
        sourceTimeUs: response.sourceTimeUs,
      });
      return;
    }

    if (message.type === "preview.dropped") {
      this.droppedFrames += 1;
      if (pending) {
        this.pending.delete(requestId);
        this.detachAbort(pending);
        pending.reject(abortError(message.reason ?? "Decode dropped"));
      }
      return;
    }

    if (message.type === "preview.error" && pending) {
      this.pending.delete(requestId);
      this.detachAbort(pending);
      pending.reject(new Error(message.error ?? "Preview decode failed"));
    }
  };

  constructor(
    workerFactory: () => WorkerTransport,
    private readonly logger?: StructuredLogger,
    lifecycle?: ResourceLifecycleTracker,
    private readonly workerLogSink?: LogSink,
  ) {
    this.lifecycle = lifecycle ?? new ResourceLifecycleTracker();
    this.worker = workerFactory();
    this.workerLease = this.lifecycle.trackWorker(this.worker);
    this.worker.addEventListener("message", this.onMessage);
  }

  decode(
    source: PreviewSource,
    sourceTimeUs: number,
    projectRevision: number,
    requestId: string,
    generation = 0,
    signal?: AbortSignal,
  ): Promise<DecodedPreviewFrame> {
    if (this.disposed) {
      return Promise.reject(new Error("PreviewDecoderClient is disposed"));
    }
    if (signal?.aborted) {
      return Promise.reject(
        abortError(String(signal.reason ?? "Decode cancelled")),
      );
    }
    this.latestRequestId = requestId;
    const metadata = previewSourceMetadata(source);
    return new Promise<DecodedPreviewFrame>((resolve, reject) => {
      const pending: PendingDecode = {
        generation,
        projectRevision,
        reject,
        resolve,
        signal,
      };
      if (signal) {
        pending.abort = () => {
          this.pending.delete(requestId);
          this.worker.postMessage({
            operation: "cancel",
            reason: String(signal.reason ?? "Decode cancelled"),
            requestId,
            type: "preview.request",
            version: PREVIEW_DECODE_PROTOCOL_VERSION,
          });
          reject(abortError(String(signal.reason ?? "Decode cancelled")));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(requestId, pending);
      this.worker.postMessage({
        cacheKey: metadata.cacheKey,
        frameRate: metadata.frameRate,
        generation,
        keyframes: source.keyframes,
        mediaUrl: source.mediaUrl,
        operation: "decode",
        projectRevision,
        requestId,
        sourceTimeUs,
        type: "preview.request",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      });
    });
  }

  stats(): PreviewDecoderStats {
    return {
      decodeQueue: this.decodeQueue,
      decoderQueue: this.decoderQueue,
      droppedFrames: this.droppedFrames,
      staleFrames: this.staleFrames,
    };
  }

  subscribeStats(listener: () => void): () => void {
    this.statsListeners.add(listener);
    return () => this.statsListeners.delete(listener);
  }

  activeResources(): number {
    return this.lifecycle.snapshot().activeTotal;
  }

  resourceSnapshot(): ResourceLifecycleSnapshot {
    return this.lifecycle.snapshot();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const [requestId, pending] of this.pending) {
      this.detachAbort(pending);
      pending.reject(abortError("Preview decoder disposed"));
      this.worker.postMessage({
        operation: "cancel",
        reason: "Preview decoder disposed",
        requestId,
        type: "preview.request",
        version: PREVIEW_DECODE_PROTOCOL_VERSION,
      });
    }
    this.pending.clear();
    this.statsListeners.clear();
    this.worker.removeEventListener("message", this.onMessage);
    this.workerLease.release();
  }

  private detachAbort(pending: PendingDecode): void {
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
  }

  private notifyStats(): void {
    for (const listener of this.statsListeners) {
      listener();
    }
  }
}
