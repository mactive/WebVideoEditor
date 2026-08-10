import type { ProjectDocument } from "@web-video-editor/domain";
import type {
  BrowserMediaSource,
  CodecQueueObservation,
  JsHeapMetrics,
  MediaProbeResult,
  QueueStats,
  ResourceLifecycleSnapshot,
} from "@web-video-editor/media-runtime";

export const MEDIA_EXPORT_OPERATION = "media.export.mp4" as const;
export const EXPORT_OUTPUT_DIRECTORY = "web-video-editor-exports-v1" as const;

export type ExportSource = {
  assetId: string;
  source: BrowserMediaSource;
};

export type MediaExportRequest = {
  project: ProjectDocument;
  sources: ExportSource[];
};

export type MediaExportStage =
  "capability" | "video" | "audio" | "mux" | "completed";

export type MediaExportProgress = {
  audioQueue: number;
  codecQueues: ExportCodecQueueMetrics;
  elapsedMs: number;
  etaMs: number;
  heap: JsHeapMetrics;
  outputBytes: number;
  processedFrames: number;
  queue: ExportQueueMetrics;
  resources: ResourceLifecycleSnapshot;
  stage: MediaExportStage;
  totalFrames: number;
  videoQueue: number;
};

export type ExportQueueMetrics = {
  audioBackpressureWaits: number;
  audioPeak: number;
  backpressureWaits: number;
  highWatermark: number;
  videoBackpressureWaits: number;
  videoPeak: number;
};

export type WebCodecsEncoderQueueObservation = {
  applicationQueue: null;
  codec: "AudioEncoder" | "VideoEncoder";
  implementation: "webcodecs";
  internalQueue: {
    available: boolean;
    backpressureWaits: number;
    highWatermark: number;
    peak: number;
    queueSize: number | null;
  };
};

export type ExportCodecQueueMetrics = {
  audioDecoder: CodecQueueObservation | null;
  audioEncoder: WebCodecsEncoderQueueObservation | null;
  videoDecoder: CodecQueueObservation;
  videoEncoder: WebCodecsEncoderQueueObservation;
};

export type MediaExportResult = {
  audioCodec: string | null;
  audioFrames: number;
  bytes: number;
  codecQueues: ExportCodecQueueMetrics;
  durationUs: number;
  elapsedMs: number;
  fileName: string;
  frames: number;
  height: number;
  heap: JsHeapMetrics;
  mimeType: "video/mp4";
  opfsPath: string;
  queue: ExportQueueMetrics;
  resources: ResourceLifecycleSnapshot;
  source: "original";
  videoCodec: string;
  width: number;
};

export type MediaExportInspection = {
  audio: {
    firstTimestampUs: number;
    lastEndTimestampUs: number;
    packetCount: number;
    timestampsMonotonic: boolean;
  } | null;
  probe: MediaProbeResult;
};

export type ExportDiagnostics = {
  cancel(): void;
  getFile(): Promise<File | null>;
  getProgress(): MediaExportProgress | null;
  getResult(): MediaExportResult | null;
  getTaskQueue(): QueueStats;
  inspectFile(): Promise<MediaExportInspection | null>;
  start(): void;
};

declare global {
  interface Window {
    __TASK_11_EXPORT__?: ExportDiagnostics;
  }
}
