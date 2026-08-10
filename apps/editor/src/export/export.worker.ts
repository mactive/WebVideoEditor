/// <reference lib="webworker" />

import {
  MediaWorkerHost,
  type WorkerMessageEndpoint,
} from "@web-video-editor/media-runtime";
import {
  StructuredLogger,
  WorkerLogSink,
  type WorkerMessageTarget,
} from "@web-video-editor/observability";

import { exportProjectToMp4 } from "./export-pipeline";
import {
  MEDIA_EXPORT_OPERATION,
  type MediaExportProgress,
  type MediaExportRequest,
  type MediaExportResult,
} from "./export-types";

const endpoint = self as unknown as WorkerMessageEndpoint & WorkerMessageTarget;
const host = new MediaWorkerHost(endpoint);
const logger = new StructuredLogger(
  new WorkerLogSink(endpoint),
  "export-worker",
);

host.register<MediaExportRequest, MediaExportResult, MediaExportProgress>(
  MEDIA_EXPORT_OPERATION,
  async (request, context) => {
    const result = await exportProjectToMp4({
      logger,
      onProgress: (progress) => {
        const frameRatio =
          progress.totalFrames === 0
            ? 0
            : progress.processedFrames / progress.totalFrames;
        const ratio =
          progress.stage === "capability"
            ? 0.02
            : progress.stage === "video"
              ? 0.05 + frameRatio * 0.8
              : progress.stage === "audio"
                ? 0.9
                : progress.stage === "mux"
                  ? 0.97
                  : 1;
        context.progress(
          {
            completed: progress.processedFrames,
            ratio,
            stage: progress.stage,
            total: progress.totalFrames,
          },
          progress,
        );
      },
      project: request.project,
      requestId: context.requestId,
      signal: context.signal,
      sources: request.sources,
    });
    return { payload: result };
  },
);
