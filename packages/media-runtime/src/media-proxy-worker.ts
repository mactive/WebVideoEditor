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
  thumbnails: 0.12,
  keyframes: 0.2,
  transcode: 0.35,
  waveform: 0.35,
  commit: 0.95,
  completed: 1,
};

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
        ratio = Math.max(ratio, stageProgress[progress.stage]);
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
