import {
  StructuredLogger,
  WorkerLogSink,
  type WorkerMessageTarget,
} from "@web-video-editor/observability";
import {
  MediaWorkerHost,
  registerMediaProxyTasks,
  registerMediaProbeTask,
  type WorkerMessageEndpoint,
} from "@web-video-editor/media-runtime";

const endpoint = self as unknown as WorkerMessageEndpoint & WorkerMessageTarget;
const host = new MediaWorkerHost(endpoint);
const logger = new StructuredLogger(
  new WorkerLogSink(endpoint),
  "media-worker",
);

const { registry } = registerMediaProbeTask(host, undefined, logger);
const { cache } = registerMediaProxyTasks(host, registry, { logger });
void cache.catch((error) => {
  logger.log({
    error,
    event: "generation.failed",
    level: "error",
    marker: "[PROXY]",
  });
});
