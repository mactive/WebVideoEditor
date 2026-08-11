import type { StructuredLogger } from "@web-video-editor/observability";

import type { MediaSourceRegistry } from "./media-probe-worker";
import { generateMediaProxy } from "./proxy-pipeline";
import { OpfsProxyCache, type ProxyCacheAdapter } from "./proxy-cache";
import {
  MEDIA_PROXY_OPERATION,
  type MediaProxyProgress,
  type MediaProxyRequest,
  type MediaProxyResult,
  type ProxyCacheStats,
} from "./proxy-types";
import type { MediaWorkerHost } from "./worker-host";

export const MEDIA_PROXY_CACHE_STATS_OPERATION =
  "media.proxy.cache.stats" as const;
export const MEDIA_PROXY_CACHE_CLEAR_OPERATION =
  "media.proxy.cache.clear" as const;

const stageProgress: Record<MediaProxyProgress["stage"], number> = {
  cache: 0.02,
  thumbnails: 0.02,
  keyframes: 0.93,
  transcode: 0.35,
  waveform: 0.35,
  commit: 0.97,
  completed: 1,
};

function timeBasedRatio(progress: MediaProxyProgress): number | undefined {
  if (
    progress.durationSec === undefined ||
    progress.processedTimeSec === undefined ||
    progress.durationSec <= 0
  ) {
    return undefined;
  }
  const fraction = Math.max(
    0,
    Math.min(1, progress.processedTimeSec / progress.durationSec),
  );
  switch (progress.stage) {
    case "thumbnails":
      return 0.02 + fraction * 0.1;
    case "transcode":
    case "waveform":
      return 0.12 + fraction * 0.8;
    case "keyframes":
      return 0.93;
    case "commit":
      return 0.97;
    case "completed":
      return 1;
    case "cache":
      return 0.02;
  }
}

export function registerMediaProxyTasks(
  host: MediaWorkerHost,
  sources: MediaSourceRegistry,
  options: {
    cache?: ProxyCacheAdapter;
    logger?: StructuredLogger;
  } = {},
): {
  cache: Promise<ProxyCacheAdapter>;
  unregister: () => void;
} {
  const cache = options.cache
    ? Promise.resolve(options.cache)
    : OpfsProxyCache.create();
  const unregisterGenerate = host.register<
    MediaProxyRequest,
    MediaProxyResult,
    MediaProxyProgress
  >(MEDIA_PROXY_OPERATION, async (request, context) => {
    const proxyCache = await cache;
    const source = sources.get(request.fingerprint);
    if (!source) {
      throw new Error(
        `No registered media source for fingerprint "${request.fingerprint}"`,
      );
    }
    let ratio = 0;
    const result = await generateMediaProxy({
      cache: proxyCache,
      fingerprint: request.fingerprint,
      logger: options.logger,
      onProgress: (progress) => {
        ratio = Math.max(
          ratio,
          timeBasedRatio(progress) ?? stageProgress[progress.stage],
        );
        context.progress(
          {
            completed: ratio,
            ratio,
            stage: progress.stage,
            total: 1,
          },
          progress,
        );
      },
      parameters: request.parameters,
      requestId: context.requestId,
      signal: context.signal,
      source,
    });
    return { payload: result };
  });
  const unregisterStats = host.register<
    Record<string, never>,
    ProxyCacheStats,
    never
  >(MEDIA_PROXY_CACHE_STATS_OPERATION, async () => ({
    payload: await (await cache).stats(),
  }));
  const unregisterClear = host.register<
    Record<string, never>,
    ProxyCacheStats,
    never
  >(MEDIA_PROXY_CACHE_CLEAR_OPERATION, async () => {
    const proxyCache = await cache;
    await proxyCache.clear();
    return { payload: await proxyCache.stats() };
  });

  return {
    cache,
    unregister: () => {
      unregisterGenerate();
      unregisterStats();
      unregisterClear();
    },
  };
}
