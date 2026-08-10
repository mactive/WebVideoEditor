import type { StructuredLogger } from "@web-video-editor/observability";

import { probeBrowserMedia } from "./probe";
import {
  MEDIA_PROBE_OPERATION,
  type BrowserMediaSource,
  type MediaProbeProgress,
  type MediaProbeRequest,
  type MediaProbeResult,
} from "./probe-types";
import type { MediaWorkerHost } from "./worker-host";

export class MediaSourceRegistry {
  private readonly sources = new Map<string, BrowserMediaSource>();

  register(fingerprint: string, source: BrowserMediaSource): void {
    this.sources.set(fingerprint, source);
  }

  get(fingerprint: string): BrowserMediaSource | undefined {
    return this.sources.get(fingerprint);
  }

  delete(fingerprint: string): boolean {
    return this.sources.delete(fingerprint);
  }

  clear(): void {
    this.sources.clear();
  }

  get size(): number {
    return this.sources.size;
  }
}

const stageProgress: Record<MediaProbeProgress["stage"], number> = {
  metadata: 1,
  tracks: 2,
  fingerprint: 3,
  completed: 4,
};

export function registerMediaProbeTask(
  host: MediaWorkerHost,
  registry = new MediaSourceRegistry(),
  logger?: StructuredLogger,
): {
  registry: MediaSourceRegistry;
  unregister: () => void;
} {
  const unregister = host.register<
    MediaProbeRequest,
    MediaProbeResult,
    MediaProbeProgress
  >(MEDIA_PROBE_OPERATION, async ({ source }, context) => {
    const result = await probeBrowserMedia(source, {
      logger,
      onProgress: (progress) => {
        const completed = stageProgress[progress.stage];
        context.progress(
          {
            completed,
            ratio: completed / 4,
            stage: progress.stage,
            total: 4,
          },
          progress,
        );
      },
      requestId: context.requestId,
      signal: context.signal,
    });
    registry.register(result.fingerprint, source);
    return { payload: result };
  });

  return { registry, unregister };
}
