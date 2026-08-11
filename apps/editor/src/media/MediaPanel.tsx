import type { Asset } from "@web-video-editor/domain";
import { LogHub, StructuredLogger } from "@web-video-editor/observability";
import {
  BoundedTaskQueue,
  MEDIA_PROXY_CACHE_CLEAR_OPERATION,
  MEDIA_PROXY_OPERATION,
  MEDIA_PROBE_OPERATION,
  WorkerClient,
  mediaProbeToProjectAsset,
  type BrowserMediaSource,
  type MediaProxyProgress,
  type MediaProxyRequest,
  type MediaProxyResult,
  type MediaProbeProgress,
  type MediaProbeRequest,
  type MediaProbeResult,
  type ProxyCacheStats,
  type ProxyGenerationParameters,
  type QueueStats,
  type ScheduledTaskHandle,
} from "@web-video-editor/media-runtime";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionAvailability } from "../capabilities";
import "./MediaPanel.css";
import { ProxyProgress, type ProxyProgressState } from "./ProxyProgress";

const TEST_ASSETS = [
  {
    description: "方形短视频 · 约 2.88 MB",
    name: "test_1.mp4",
    url: "/test_assets/test_1.mp4",
  },
  {
    description: "横屏长视频 · 约 911 MB",
    name: "test_2.mp4",
    url: "/test_assets/test_2.mp4",
  },
  {
    description: "竖屏视频 · 约 141.75 MB",
    name: "test_3.mp4",
    url: "/test_assets/test_3.mp4",
  },
] as const;

const LONG_PROXY_DURATION_SEC = 10 * 60;
const PROXY_TIMEOUT_MIN_MS = 5 * 60_000;
const PROXY_TIMEOUT_MAX_MS = 30 * 60_000;

function proxyParametersFor(
  result: MediaProbeResult,
): Partial<ProxyGenerationParameters> | undefined {
  if (result.durationSec < LONG_PROXY_DURATION_SEC) {
    return undefined;
  }
  return {
    frameRate: 15,
    maxThumbnailCount: 120,
    thumbnailIntervalSec: 30,
  };
}

function proxyTimeoutMs(result: MediaProbeResult): number {
  return Math.min(
    PROXY_TIMEOUT_MAX_MS,
    Math.max(PROXY_TIMEOUT_MIN_MS, result.durationSec * 250),
  );
}

type ProbeItem = {
  error?: string;
  id: string;
  name: string;
  progress?: MediaProbeProgress;
  proxy?: ProxyProgressState;
  result?: MediaProbeResult;
  status: "failed" | "probing" | "ready";
};

export type TimelineAddContext = {
  assetName: string;
  cacheStatus: "hit" | "miss" | "pending";
  isLongVideo: boolean;
  previewSource: "proxy" | "source";
  proxyStatus: ProxyProgressState["status"] | "not-started";
  risk: string;
};

export type MediaPanelProps = {
  actionAvailability?: ActionAvailability;
  logHub?: LogHub;
  onAddToTimeline?: (assetId: string, context: TimelineAddContext) => void;
  onAssetImported?: (
    asset: Asset,
    result: MediaProbeResult,
    source: BrowserMediaSource,
  ) => void;
  onProxyReady?: (asset: Asset, result: MediaProxyResult) => void;
  projectAssets?: readonly Asset[];
  timelineAssetIds?: readonly string[];
};

type MediaQueueDiagnostics = {
  getImportQueue(): QueueStats;
  getProxyQueue(): QueueStats;
  probe(source: BrowserMediaSource): Promise<MediaProbeResult>;
};

declare global {
  interface Window {
    __TASK_14_MEDIA__?: MediaQueueDiagnostics;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function timelineAddContext(item: ProbeItem): TimelineAddContext | undefined {
  if (!item.result) {
    return undefined;
  }
  const proxyStatus = item.proxy?.status ?? "not-started";
  const cacheStatus =
    item.proxy?.result?.cache.status ??
    item.proxy?.progress?.cacheStatus ??
    "pending";
  const proxyReady = proxyStatus === "ready";
  const isLongVideo = item.result.durationSec >= LONG_PROXY_DURATION_SEC;
  const previewSource = proxyReady ? "proxy" : "source";
  let risk: string;
  if (proxyReady && cacheStatus === "hit") {
    risk = "Proxy cache hit，可直接使用 OPFS proxy 预览。";
  } else if (proxyReady) {
    risk = "Proxy 已就绪，添加后使用低分辨率 proxy 预览。";
  } else if (proxyStatus === "queued" || proxyStatus === "running") {
    risk = isLongVideo
      ? "可立即添加，但当前使用 source fallback；长视频直解码 seek/播放可能较慢，proxy 将在后台继续生成。"
      : "可立即添加，当前临时使用 source fallback；proxy 后台完成后会切换到 proxy。";
  } else if (proxyStatus === "failed") {
    risk =
      "Proxy 生成失败；仍可添加，但会持续使用 source fallback，预览性能取决于原素材解码。";
  } else if (proxyStatus === "cancelled") {
    risk =
      "Proxy 已取消；仍可添加，但会使用 source fallback，可直接重试代理。";
  } else {
    risk = "可立即添加，proxy 尚未开始回传状态时使用 source fallback。";
  }
  return {
    assetName: item.name,
    cacheStatus,
    isLongVideo,
    previewSource,
    proxyStatus,
    risk,
  };
}

function proxyStatusText(context: TimelineAddContext): string {
  const parts = [
    `preview=${context.previewSource}`,
    `proxy=${context.proxyStatus}`,
    `cache=${context.cacheStatus}`,
  ];
  if (context.isLongVideo) {
    parts.push("long-video");
  }
  return parts.join(" · ");
}

export function MediaPanel({
  actionAvailability,
  logHub: providedLogHub,
  onAddToTimeline,
  onAssetImported,
  onProxyReady,
  projectAssets = [],
  timelineAssetIds = [],
}: MediaPanelProps) {
  const [items, setItems] = useState<ProbeItem[]>([]);
  const [cacheStats, setCacheStats] = useState<ProxyCacheStats>();
  const [importQueueStats, setImportQueueStats] = useState<QueueStats>({
    active: 0,
    activePeak: 0,
    backpressureCount: 0,
    concurrency: 1,
    highWatermark: 2,
    queued: 0,
    queuedPeak: 0,
  });
  const [queueStats, setQueueStats] = useState<QueueStats>({
    active: 0,
    activePeak: 0,
    backpressureCount: 0,
    concurrency: 1,
    highWatermark: 2,
    queued: 0,
    queuedPeak: 0,
  });
  const clientRef = useRef<WorkerClient | undefined>(undefined);
  const importQueueRef = useRef<BoundedTaskQueue | undefined>(undefined);
  const proxyQueueRef = useRef<BoundedTaskQueue | undefined>(undefined);
  const proxyTasksRef = useRef(
    new Map<
      string,
      ScheduledTaskHandle<MediaProxyResult, MediaProxyProgress>
    >(),
  );
  const fallbackLogHub = useMemo(() => new LogHub(), []);
  const logHub = providedLogHub ?? fallbackLogHub;
  const importEnabled = actionAvailability?.enabled === true;

  useEffect(() => {
    if (!importEnabled) {
      return;
    }
    const client = new WorkerClient({
      defaultTimeoutMs: 5 * 60_000,
      logger: new StructuredLogger(logHub, "media-panel"),
      workerFactory: () =>
        new Worker(new URL("./media.worker.ts", import.meta.url), {
          name: "media-probe-worker",
          type: "module",
        }),
      workerLogSink: logHub,
    });
    const proxyQueue = new BoundedTaskQueue(client, {
      concurrency: 1,
      highWatermark: 2,
      logger: new StructuredLogger(logHub, "proxy-queue"),
      marker: "[PROXY]",
      operation: MEDIA_PROXY_OPERATION,
    });
    const importQueue = new BoundedTaskQueue(client, {
      concurrency: 1,
      highWatermark: 2,
      logger: new StructuredLogger(logHub, "import-queue"),
      marker: "[IMPORT]",
      operation: MEDIA_PROBE_OPERATION,
    });
    const proxyTasks = proxyTasksRef.current;
    clientRef.current = client;
    importQueueRef.current = importQueue;
    proxyQueueRef.current = proxyQueue;
    const queueSubscription = proxyQueue.events$.subscribe(() => {
      queueMicrotask(() => setQueueStats(proxyQueue.stats()));
    });
    const importQueueSubscription = importQueue.events$.subscribe(() => {
      queueMicrotask(() => setImportQueueStats(importQueue.stats()));
    });
    window.__TASK_14_MEDIA__ = {
      getImportQueue: () => importQueue.stats(),
      getProxyQueue: () => proxyQueue.stats(),
      probe: (source) =>
        importQueue.schedule<MediaProbeRequest, MediaProbeResult>(
          0,
          { source },
          { requestId: `diagnostic-probe-${crypto.randomUUID()}` },
        ).result,
    };
    return () => {
      clientRef.current = undefined;
      importQueueRef.current = undefined;
      proxyQueueRef.current = undefined;
      proxyTasks.clear();
      queueSubscription.unsubscribe();
      importQueueSubscription.unsubscribe();
      delete window.__TASK_14_MEDIA__;
      importQueue.dispose();
      proxyQueue.dispose();
      client.dispose();
    };
  }, [importEnabled, logHub]);

  const generateProxy = (id: string, result: MediaProbeResult) => {
    const queue = proxyQueueRef.current;
    if (!queue) {
      return;
    }
    const requestId = `proxy_${id}`;
    const task = queue.schedule<
      MediaProxyRequest,
      MediaProxyResult,
      MediaProxyProgress
    >(
      0,
      {
        fingerprint: result.fingerprint,
        parameters: proxyParametersFor(result),
      },
      { requestId, timeoutMs: proxyTimeoutMs(result) },
    );
    proxyTasksRef.current.set(id, task);
    setItems((current) =>
      current.map((item) =>
        item.id === id
          ? {
              ...item,
              proxy: { ratio: 0, status: "queued" },
            }
          : item,
      ),
    );
    task.progress$.subscribe(({ payload, progress }) => {
      if (!payload) {
        return;
      }
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                proxy: {
                  progress: {
                    ...item.proxy?.progress,
                    ...payload,
                    elapsedMs: payload.elapsedMs,
                    stage: payload.stage,
                  },
                  ratio: progress.ratio,
                  status: "running",
                },
              }
            : item,
        ),
      );
    });
    void task.result.then(
      (proxyResult) => {
        proxyTasksRef.current.delete(id);
        onProxyReady?.(mediaProbeToProjectAsset(result), proxyResult);
        setCacheStats(proxyResult.cache);
        setItems((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  proxy: {
                    progress: item.proxy?.progress,
                    ratio: 1,
                    result: proxyResult,
                    status: "ready",
                  },
                }
              : item,
          ),
        );
      },
      (error: unknown) => {
        proxyTasksRef.current.delete(id);
        const cancelled =
          error instanceof DOMException && error.name === "AbortError";
        setItems((current) =>
          current.map((item) =>
            item.id === id
              ? {
                  ...item,
                  proxy: {
                    error: errorMessage(error),
                    progress: item.proxy?.progress,
                    ratio: item.proxy?.ratio ?? 0,
                    status: cancelled ? "cancelled" : "failed",
                  },
                }
              : item,
          ),
        );
      },
    );
  };

  const probe = (source: BrowserMediaSource) => {
    const queue = importQueueRef.current;
    if (!queue) {
      return;
    }
    const id = crypto.randomUUID();
    setItems((current) => [
      { id, name: source.name, status: "probing" },
      ...current,
    ]);
    let task: ScheduledTaskHandle<MediaProbeResult, MediaProbeProgress>;
    try {
      task = queue.schedule<
        MediaProbeRequest,
        MediaProbeResult,
        MediaProbeProgress
      >(0, { source }, { requestId: `probe_${id}` });
    } catch (error) {
      setItems((current) =>
        current.map((item) =>
          item.id === id
            ? { ...item, error: errorMessage(error), status: "failed" }
            : item,
        ),
      );
      return;
    }
    task.progress$.subscribe(({ payload }) => {
      if (!payload) {
        return;
      }
      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, progress: payload } : item,
        ),
      );
    });
    void task.result.then(
      (result) => {
        const asset = mediaProbeToProjectAsset(result);
        onAssetImported?.(asset, result, source);
        setItems((current) =>
          current.map((item) =>
            item.id === id ? { ...item, result, status: "ready" } : item,
          ),
        );
        generateProxy(id, result);
      },
      (error: unknown) => {
        setItems((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, error: errorMessage(error), status: "failed" }
              : item,
          ),
        );
      },
    );
  };

  const selectFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      probe({
        blob: file,
        kind: "file",
        lastModified: file.lastModified,
        name: file.name,
      });
    }
  };

  return (
    <section className="media-panel" aria-labelledby="media-panel-title">
      <div className="media-panel__heading">
        <div>
          <p className="eyebrow">MEDIA IMPORT · TASK 06</p>
          <h2 id="media-panel-title">素材探测</h2>
          <p>
            File/Blob/URL 由 Media Worker 按需读取；工程仅保存指纹和小型元数据。
          </p>
        </div>
        <label className="media-panel__picker">
          选择 MP4
          <input
            accept="video/mp4,.mp4"
            disabled={!importEnabled}
            multiple
            onChange={(event) => {
              selectFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
            type="file"
          />
        </label>
      </div>

      <div className="media-panel__test-assets" aria-label="开发测试素材">
        {TEST_ASSETS.map((asset) => (
          <button
            disabled={!importEnabled}
            key={asset.name}
            onClick={() =>
              probe({
                kind: "test-asset",
                name: asset.name,
                url: asset.url,
              })
            }
            type="button"
          >
            <strong>{asset.name}</strong>
            <span>{asset.description}</span>
          </button>
        ))}
      </div>

      {!actionAvailability ? (
        <p className="media-panel__diagnosis">正在检测导入能力…</p>
      ) : !actionAvailability.enabled ? (
        <p className="media-panel__diagnosis" role="alert">
          导入已禁用：{actionAvailability.reason}
        </p>
      ) : null}

      <div className="media-panel__status">
        <span>Project Assets: {projectAssets.length}</span>
        <span>Runtime probes: {items.length}</span>
        <span>
          OPFS: {cacheStats ? formatBytes(cacheStats.committedBytes) : "—"}
        </span>
        <span data-testid="proxy-queue-watermark">
          Proxy: {queueStats.active}/{queueStats.queued} · peak{" "}
          {queueStats.activePeak}/{queueStats.queuedPeak} · HWM{" "}
          {queueStats.highWatermark}
        </span>
        <span data-testid="import-queue-watermark">
          Import: {importQueueStats.active}/{importQueueStats.queued} · peak{" "}
          {importQueueStats.activePeak}/{importQueueStats.queuedPeak} · HWM{" "}
          {importQueueStats.highWatermark}
        </span>
        <span data-testid="opfs-storage-usage">
          Storage:{" "}
          {cacheStats?.storageEstimate.available
            ? `${formatBytes(cacheStats.storageEstimate.usageBytes ?? 0)} / ${formatBytes(cacheStats.storageEstimate.quotaBytes ?? 0)}`
            : "N/A"}
        </span>
        <button
          disabled={!importEnabled}
          onClick={() => {
            const client = clientRef.current;
            if (!client) {
              return;
            }
            void client
              .request<Record<string, never>, ProxyCacheStats>(
                MEDIA_PROXY_CACHE_CLEAR_OPERATION,
                0,
                {},
              )
              .result.then(setCacheStats);
          }}
          type="button"
        >
          清理代理缓存
        </button>
      </div>

      {items.length === 0 ? (
        <p className="media-panel__empty">
          选择本地文件或载入固定测试素材开始探测。
        </p>
      ) : (
        <ul className="media-panel__results">
          {items.map((item) => {
            const video = item.result?.videoTracks.find(
              (track) => track.trackId === item.result?.primaryVideoTrackId,
            );
            const audio = item.result?.audioTracks.find(
              (track) => track.trackId === item.result?.primaryAudioTrackId,
            );
            const addContext = timelineAddContext(item);
            return (
              <li key={item.id} data-status={item.status}>
                <div className="media-panel__result-title">
                  <strong>{item.name}</strong>
                  <span>{item.status.toUpperCase()}</span>
                </div>
                {item.status === "probing" ? (
                  <p>
                    {item.progress?.stage ?? "starting"} · 已按需读取{" "}
                    {formatBytes(item.progress?.bytesRead ?? 0)}
                  </p>
                ) : null}
                {item.error ? (
                  <p className="media-panel__error">{item.error}</p>
                ) : null}
                {item.result && video ? (
                  <>
                    <dl>
                      <div>
                        <dt>视频</dt>
                        <dd>
                          {video.codec?.toUpperCase()} {video.profile} ·{" "}
                          {video.displayWidth}×{video.displayHeight} ·{" "}
                          {video.frameRate.toFixed(2)}fps · rotation{" "}
                          {video.rotation}°
                        </dd>
                      </div>
                      <div>
                        <dt>音频</dt>
                        <dd>
                          {audio
                            ? `${audio.codec?.toUpperCase()} ${audio.profile} · ${audio.sampleRate}Hz · ${audio.channels}ch`
                            : "无"}
                        </dd>
                      </div>
                      <div>
                        <dt>时长</dt>
                        <dd>{formatDuration(item.result.durationSec)}</dd>
                      </div>
                      <div>
                        <dt>读取</dt>
                        <dd>
                          {item.result.read.adapter} · {item.result.read.mode} ·{" "}
                          {formatBytes(item.result.read.uniqueBytesRead)} /{" "}
                          {formatBytes(item.result.source.size)} ·{" "}
                          {(item.result.read.readRatio * 100).toFixed(3)}%
                        </dd>
                      </div>
                      <div>
                        <dt>JS Heap</dt>
                        <dd data-testid={`heap-${item.result.source.name}`}>
                          {item.progress?.heap.available
                            ? formatBytes(
                                item.progress.heap.usedJSHeapSize ?? 0,
                              )
                            : "N/A"}
                        </dd>
                      </div>
                      <div>
                        <dt>指纹</dt>
                        <dd>{item.result.fingerprint}</dd>
                      </div>
                      <div>
                        <dt>排除</dt>
                        <dd>
                          {item.result.excludedVideoTracks.length > 0
                            ? item.result.excludedVideoTracks
                                .map(
                                  (track) =>
                                    `${track.codec.toUpperCase()} (${track.reason})`,
                                )
                                .join(", ")
                            : "无附加视频轨"}
                        </dd>
                      </div>
                    </dl>
                    {addContext ? (
                      <div
                        className="media-panel__add-strategy"
                        data-preview-source={addContext.previewSource}
                        data-proxy-status={addContext.proxyStatus}
                      >
                        <strong>{proxyStatusText(addContext)}</strong>
                        <span>{addContext.risk}</span>
                      </div>
                    ) : null}
                    <button
                      className="media-panel__add"
                      data-testid={`add-${item.result.source.name}`}
                      onClick={() =>
                        onAddToTimeline?.(
                          mediaProbeToProjectAsset(item.result!).id,
                          addContext!,
                        )
                      }
                      type="button"
                    >
                      {addContext?.previewSource === "proxy"
                        ? "添加到时间线"
                        : "立即添加到时间线（source fallback）"}
                      {timelineAssetIds.includes(
                        mediaProbeToProjectAsset(item.result).id,
                      )
                        ? "（可重复）"
                        : ""}
                    </button>
                  </>
                ) : null}
                {item.proxy ? (
                  <ProxyProgress
                    onCancel={() =>
                      proxyTasksRef.current
                        .get(item.id)
                        ?.cancel("Proxy cancelled by user")
                    }
                    onRetry={() => {
                      if (item.result) {
                        generateProxy(item.id, item.result);
                      }
                    }}
                    state={item.proxy}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
