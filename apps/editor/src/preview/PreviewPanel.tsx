import {
  projectContentEndUs,
  type ProjectDocument,
} from "@web-video-editor/domain";
import {
  MediabunnyAudioPlayback,
  createMediabunnyDecoderQueueObservation,
  sampleJsHeapMetrics,
  sampleStorageEstimate,
  type JsHeapMetrics,
  type PlaybackMediaSource,
  type StorageEstimateMetrics,
} from "@web-video-editor/media-runtime";
import {
  ConsoleLogSink,
  LogHub,
  StructuredLogger,
} from "@web-video-editor/observability";
import {
  PixiPreviewRenderer,
  PreviewDecoderClient,
  PreviewRuntime,
  previewSourceMetadata,
  resolveQualityProfile,
  type PreviewRuntimeSnapshot,
  type PreviewSource,
} from "@web-video-editor/preview-runtime";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionAvailability } from "../capabilities";
import "./PreviewPanel.css";

export type PreviewPanelProps = {
  actionAvailability?: ActionAvailability;
  audioSources?: ReadonlyMap<string, PlaybackMediaSource>;
  diagnosticsLoggingEnabled?: boolean;
  embedded?: boolean;
  logHub?: LogHub;
  onPlayheadChange?: (playheadUs: number) => void;
  playheadUs?: number;
  project: ProjectDocument;
  sources: readonly PreviewSource[];
};

type PreviewDiagnostics = {
  dispose(): void;
  getResources(): ReturnType<PreviewRuntime["resourceSnapshot"]>;
  getSnapshot(): PreviewRuntimeSnapshot;
  seek(playheadUs: number): void;
};

type RuntimeDashboardSample = {
  heap: JsHeapMetrics;
  sampledAtMs: number;
  storage: StorageEstimateMetrics;
};

declare global {
  interface Window {
    __TASK_8_PREVIEW__?: PreviewDiagnostics;
  }
}

function formatTime(timeUs: number): string {
  return `${(timeUs / 1_000_000).toFixed(2)}s`;
}

function projectDurationUs(project: ProjectDocument): number {
  return Math.max(project.timeline.durationUs, projectContentEndUs(project));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "N/A";
  }
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function formatJsHeapMetrics(heap: JsHeapMetrics): string {
  if (!heap.available) {
    return "N/A";
  }
  return [
    `used ${formatBytes(heap.usedJSHeapSize)}`,
    `total ${formatBytes(heap.totalJSHeapSize)}`,
    `limit ${formatBytes(heap.jsHeapSizeLimit)}`,
  ].join(" · ");
}

function formatStorageMetrics(storage: StorageEstimateMetrics): string {
  if (!storage.available) {
    return "N/A";
  }
  return `usage ${formatBytes(storage.usageBytes)} / quota ${formatBytes(storage.quotaBytes)}`;
}

function isPreviewShortcutInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (target.closest("input, textarea, select, button")) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }
  const editable = target.closest("[contenteditable]");
  return (
    editable instanceof HTMLElement &&
    editable.getAttribute("contenteditable")?.toLowerCase() !== "false"
  );
}

function initialSnapshot(project: ProjectDocument): PreviewRuntimeSnapshot {
  const profile = resolveQualityProfile(project, "preview");
  return {
    buffering: false,
    durationUs: projectDurationUs(project),
    metrics: {
      activeResources: 0,
      activeVideoLayers: 0,
      audioActiveSources: 0,
      audioGeneration: 0,
      avDriftUs: 0,
      cacheHitRate: 0,
      clockSource: "performance",
      clockTransportMode: "message",
      codecQueues: {
        audioDecoder: null,
        videoDecoder: createMediabunnyDecoderQueueObservation("VideoDecoder"),
      },
      decodeQueue: 0,
      droppedFrames: 0,
      fps: 0,
      frameTimestampErrorUs: 0,
      height: profile.height,
      playheadUs: 0,
      presentedPlayheadUs: 0,
      presentedFrames: 0,
      resyncs: 0,
      staleFrames: 0,
      timestampDrops: 0,
      width: profile.width,
    },
    playing: false,
    ready: false,
  };
}

export function PreviewPanel({
  actionAvailability,
  audioSources,
  diagnosticsLoggingEnabled = true,
  embedded = false,
  logHub: providedLogHub,
  onPlayheadChange,
  playheadUs,
  project,
  sources,
}: PreviewPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PreviewRuntime | undefined>(undefined);
  const projectRef = useRef(project);
  const playheadRef = useRef(playheadUs);
  const diagnosticsLoggingEnabledRef = useRef(diagnosticsLoggingEnabled);
  const onPlayheadChangeRef = useRef(onPlayheadChange);
  const fallbackLogHub = useMemo(() => new LogHub([new ConsoleLogSink()]), []);
  const [snapshot, setSnapshot] = useState(() => initialSnapshot(project));
  const [activeVideoFrames, setActiveVideoFrames] = useState(0);
  const [runtimeMetrics, setRuntimeMetrics] = useState<RuntimeDashboardSample>(
    () => ({
      heap: sampleJsHeapMetrics(),
      sampledAtMs: performance.now(),
      storage: { available: false },
    }),
  );
  const [metricsExpanded, setMetricsExpanded] = useState(true);
  const previewEnabled = actionAvailability?.enabled === true;
  const hasPreviewSources = sources.length > 0;
  const sourceKey = sources
    .map((source) => {
      const metadata = previewSourceMetadata(source);
      return `${source.assetId}:${metadata.cacheKey}:${source.mediaUrl ?? "opfs"}`;
    })
    .join("|");
  const audioSourceKey = [...(audioSources?.entries() ?? [])]
    .map(([assetId, source]) =>
      source.kind === "opfs-proxy"
        ? `${assetId}:${source.kind}:${source.cacheKey}`
        : source.kind === "url"
          ? `${assetId}:${source.kind}:${source.url}`
          : `${assetId}:${source.kind}:${source.blob.size}`,
    )
    .join("|");

  useEffect(() => {
    projectRef.current = project;
    playheadRef.current = playheadUs;
    diagnosticsLoggingEnabledRef.current = diagnosticsLoggingEnabled;
    onPlayheadChangeRef.current = onPlayheadChange;
  }, [diagnosticsLoggingEnabled, onPlayheadChange, playheadUs, project]);

  useEffect(() => {
    let active = true;
    const sample = () => {
      const heap = sampleJsHeapMetrics();
      void sampleStorageEstimate().then((storage) => {
        if (active) {
          setRuntimeMetrics({
            heap,
            sampledAtMs: performance.now(),
            storage,
          });
        }
      });
    };
    sample();
    const interval = window.setInterval(sample, 1_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !previewEnabled || !hasPreviewSources) {
      setSnapshot(initialSnapshot(projectRef.current));
      host?.replaceChildren();
      return;
    }
    let disposed = false;
    let unsubscribe: () => void = () => undefined;
    let renderer: PixiPreviewRenderer | undefined;
    let decoder: PreviewDecoderClient | undefined;
    let audio: MediabunnyAudioPlayback | undefined;
    let runtime: PreviewRuntime | undefined;
    const logHub = providedLogHub ?? fallbackLogHub;
    const logger = new StructuredLogger(logHub, "preview-panel");
    const currentProject = projectRef.current;
    const profile = resolveQualityProfile(currentProject, "preview");

    void (async () => {
      renderer = new PixiPreviewRenderer({
        backgroundColor: currentProject.canvas.backgroundColor,
        logger,
        profile,
      });
      await renderer.init(host);
      if (disposed) {
        renderer.destroy();
        return;
      }
      decoder = new PreviewDecoderClient(
        () =>
          new Worker(new URL("./preview.worker.ts", import.meta.url), {
            name: "preview-decoder-worker",
            type: "module",
          }),
        logger,
        undefined,
        logHub,
        () => diagnosticsLoggingEnabledRef.current,
      );
      audio =
        audioSources && audioSources.size > 0
          ? new MediabunnyAudioPlayback({
              logger,
              sources: audioSources,
            })
          : undefined;
      runtime = new PreviewRuntime({
        audio,
        decoder,
        logger,
        project: currentProject,
        renderer,
        sources,
      });
      runtimeRef.current = runtime;
      if (playheadRef.current !== undefined) {
        runtime.seek(playheadRef.current);
      }
      const update = () => {
        if (!runtime) {
          return;
        }
        const next = runtime.getSnapshot();
        setSnapshot(next);
        setActiveVideoFrames(
          runtime.resourceSnapshot().byType["video-frame"].active,
        );
        onPlayheadChangeRef.current?.(next.metrics.playheadUs);
      };
      unsubscribe = runtime.subscribe(update);
      window.__TASK_8_PREVIEW__ = {
        dispose: () => runtime?.dispose(),
        getResources: () => runtime!.resourceSnapshot(),
        getSnapshot: () => runtime!.getSnapshot(),
        seek: (nextPlayheadUs) => runtime?.seek(nextPlayheadUs),
      };
      update();
    })().catch((error: unknown) => {
      setSnapshot((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    });

    return () => {
      disposed = true;
      unsubscribe();
      runtimeRef.current = undefined;
      delete window.__TASK_8_PREVIEW__;
      if (runtime) {
        runtime.dispose();
      } else {
        decoder?.dispose();
        void audio?.dispose();
        renderer?.destroy();
      }
    };
  }, [fallbackLogHub, hasPreviewSources, providedLogHub, previewEnabled]);

  useEffect(() => {
    runtimeRef.current?.setSources(sources);
  }, [sourceKey, sources]);

  useEffect(() => {
    if (audioSources) {
      runtimeRef.current?.setAudioSources(audioSources);
    }
  }, [audioSourceKey, audioSources]);

  useEffect(() => {
    runtimeRef.current?.setProject(project);
  }, [project]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (
      runtime &&
      playheadUs !== undefined &&
      Math.abs(runtime.getSnapshot().metrics.playheadUs - playheadUs) > 1
    ) {
      runtime.seek(playheadUs);
    }
  }, [playheadUs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !previewEnabled ||
        !hasPreviewSources ||
        !snapshot.ready ||
        isPreviewShortcutInputTarget(event.target)
      ) {
        return;
      }
      const runtime = runtimeRef.current;
      if (!runtime) {
        return;
      }

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        if (runtime.getSnapshot().playing) {
          runtime.pause();
        } else {
          runtime.play();
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        runtime.step(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        runtime.step(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasPreviewSources, previewEnabled, snapshot.ready]);

  const runtime = runtimeRef.current;
  const effects = project.clips.flatMap((clip) => clip.effects);
  const videoDecodeQueue =
    snapshot.metrics.codecQueues.videoDecoder.applicationQueue;
  const audioDecodeQueue =
    snapshot.metrics.codecQueues.audioDecoder?.applicationQueue;
  const sourceSummary = sources.map((source) => {
    const metadata = previewSourceMetadata(source);
    return {
      assetId: source.assetId,
      cacheStatus: source.cacheStatus,
      kind: "manifest" in source ? "proxy" : "source",
      metadata,
    };
  });
  const sourceSummaryText =
    sourceSummary.length > 0
      ? sourceSummary
          .map(
            (source) =>
              `${source.assetId}: ${source.kind}${source.kind === "source" ? " fallback" : ""} · cache ${source.cacheStatus} · ${source.metadata.width}×${source.metadata.height}`,
          )
          .join(" / ")
      : "N/A";
  const jsHeapSummaryText = formatJsHeapMetrics(runtimeMetrics.heap);
  const storageSummaryText = formatStorageMetrics(runtimeMetrics.storage);
  const videoDecodeQueueText = `${videoDecodeQueue.active}/${videoDecodeQueue.queued} · peak ${videoDecodeQueue.activePeak}/${videoDecodeQueue.queuedPeak} · HWM ${videoDecodeQueue.highWatermark} · bp ${videoDecodeQueue.backpressureCount}`;
  const audioDecodeQueueText = audioDecodeQueue
    ? `${audioDecodeQueue.active}/${audioDecodeQueue.queued} · peak ${audioDecodeQueue.activePeak}/${audioDecodeQueue.queuedPeak} · HWM ${audioDecodeQueue.highWatermark} · bp ${audioDecodeQueue.backpressureCount}`
    : "N/A";

  return (
    <section
      className={`preview-panel${embedded ? " preview-panel--embedded" : ""}`}
      data-active-audio-sources={snapshot.metrics.audioActiveSources}
      data-active-resources={snapshot.metrics.activeResources}
      data-active-video-layers={snapshot.metrics.activeVideoLayers}
      data-active-video-frames={activeVideoFrames}
      data-decode-active={videoDecodeQueue.active}
      data-decode-backpressure={videoDecodeQueue.backpressureCount}
      data-decode-hwm={videoDecodeQueue.highWatermark}
      data-decode-queued={videoDecodeQueue.queued}
      data-presented-frames={snapshot.metrics.presentedFrames}
      data-ready={snapshot.ready}
      data-runtime-sampled-at={Math.round(runtimeMetrics.sampledAtMs)}
      aria-labelledby="preview-panel-title"
    >
      {!embedded ? (
        <div className="preview-panel__heading">
          <div>
            <p className="eyebrow">PREVIEW RUNTIME · TASK 08</p>
            <h1 id="preview-panel-title">低分辨率真实代理预览</h1>
            <p>
              Miniplex ECS → PixiJS v8 Scene Graph；Worker 从 OPFS
              代理按关键帧解码 VideoFrame。
            </p>
          </div>
          <a href="/">返回能力与素材页</a>
        </div>
      ) : (
        <h2 className="preview-panel__embedded-title" id="preview-panel-title">
          实时预览
        </h2>
      )}

      <div className="preview-panel__workspace">
        <div className="preview-panel__stage">
          <div
            className="preview-panel__canvas"
            data-testid="pixi-preview-host"
            ref={hostRef}
          />
          {!actionAvailability ? (
            <span className="preview-panel__loading">正在检测预览能力…</span>
          ) : !actionAvailability.enabled ? (
            <p className="preview-panel__error" role="alert">
              预览已禁用：{actionAvailability.reason}
            </p>
          ) : sources.length === 0 ? (
            <span className="preview-panel__loading">
              导入素材并添加到时间线
            </span>
          ) : !snapshot.ready ? (
            <span className="preview-panel__loading">初始化 PixiJS…</span>
          ) : null}
          {snapshot.error ? (
            <p className="preview-panel__error" role="alert">
              {snapshot.error}
            </p>
          ) : null}
        </div>

        {!embedded ? (
          <aside className="preview-panel__effects">
            <span>ACTIVE EFFECTS</span>
            {effects.length === 0 ? (
              <strong>无滤镜</strong>
            ) : (
              effects.map((effect) => (
                <strong key={effect.id}>{effect.kind}</strong>
              ))
            )}
            <small>效果参数与 export quality profile 共用同一语义。</small>
          </aside>
        ) : null}
      </div>

      <div className="preview-panel__controls">
        <button
          disabled={!previewEnabled || !snapshot.ready}
          onClick={() =>
            snapshot.playing ? runtime?.pause() : runtime?.play()
          }
          type="button"
        >
          {snapshot.playing ? "暂停" : "播放"}
        </button>
        <button
          disabled={!previewEnabled || !snapshot.ready}
          onClick={() => runtime?.step(-1)}
          type="button"
        >
          上一帧
        </button>
        <button
          disabled={!previewEnabled || !snapshot.ready}
          onClick={() => runtime?.step(1)}
          type="button"
        >
          下一帧
        </button>
        <span>{formatTime(snapshot.metrics.playheadUs)}</span>
        <input
          aria-label="预览播放头"
          disabled={!previewEnabled || !snapshot.ready}
          max={snapshot.durationUs}
          min={0}
          onChange={(event) => {
            const nextPlayhead = Number(event.currentTarget.value);
            runtime?.seek(nextPlayhead);
            onPlayheadChangeRef.current?.(nextPlayhead);
          }}
          step={1}
          type="range"
          value={snapshot.metrics.playheadUs}
        />
        <span>{formatTime(snapshot.durationUs)}</span>
      </div>

      <section className="preview-panel__metrics-panel" aria-label="预览指标">
        <div className="preview-panel__metrics-header">
          <div
            className="preview-panel__metrics-summary"
            data-testid="preview-metrics-summary"
          >
            <span>
              <strong>Source</strong> {sourceSummaryText}
            </span>
            <span>
              <strong>FPS</strong> {snapshot.metrics.fps}
            </span>
            <span>
              <strong>JS Heap</strong> {jsHeapSummaryText}
            </span>
          </div>
          <button
            aria-controls="preview-metrics-details"
            aria-expanded={metricsExpanded}
            className="preview-panel__metrics-toggle"
            data-testid="preview-metrics-toggle"
            onClick={() => setMetricsExpanded((expanded) => !expanded)}
            type="button"
          >
            {metricsExpanded ? "收起指标" : "展开指标"}
          </button>
        </div>
        <dl
          className="preview-panel__metrics"
          hidden={!metricsExpanded}
          id="preview-metrics-details"
        >
          <div
            className="preview-panel__metrics-health"
            data-testid="preview-health-row"
          >
            <dt>内存 / 资源健康</dt>
            <dd className="preview-panel__health-grid">
              <span data-testid="runtime-js-heap">
                <strong>页面 JS Heap</strong> {jsHeapSummaryText}
                <small>非系统内存 · Worker heap N/A</small>
              </span>
              <span data-testid="runtime-storage">
                <strong>Storage</strong> {storageSummaryText}
              </span>
              <span data-testid="active-resources">
                <strong>活跃资源</strong> {snapshot.metrics.activeResources} ·
                Video Layers {snapshot.metrics.activeVideoLayers} · Audio
                Sources {snapshot.metrics.audioActiveSources} · VideoFrame{" "}
                {activeVideoFrames}
              </span>
              <span data-testid="runtime-video-decoder">
                <strong>Video Decode</strong> {videoDecodeQueueText}
              </span>
              <span data-testid="runtime-audio-decoder">
                <strong>Audio Decode</strong> {audioDecodeQueueText}
              </span>
            </dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd data-testid="preview-source-mode">{sourceSummaryText}</dd>
          </div>
          <div>
            <dt>预览分辨率</dt>
            <dd data-testid="proxy-resolution">
              {snapshot.metrics.width}×{snapshot.metrics.height}
            </dd>
          </div>
          <div>
            <dt>FPS</dt>
            <dd data-testid="preview-fps">{snapshot.metrics.fps}</dd>
          </div>
          <div>
            <dt>应用解码队列 / 内部队列</dt>
            <dd data-testid="decode-queue">
              {videoDecodeQueue.active}/{videoDecodeQueue.queued} · HWM{" "}
              {videoDecodeQueue.highWatermark} / N/A
            </dd>
          </div>
          <div>
            <dt>Cache Hit</dt>
            <dd>{percent(snapshot.metrics.cacheHitRate)}</dd>
          </div>
          <div>
            <dt>丢帧 / 过期</dt>
            <dd data-testid="dropped-frames">
              {snapshot.metrics.droppedFrames} / {snapshot.metrics.staleFrames}
            </dd>
          </div>
          <div>
            <dt>时钟 / A/V drift</dt>
            <dd data-testid="av-drift">
              {snapshot.metrics.clockSource} /{" "}
              {(snapshot.metrics.avDriftUs / 1_000).toFixed(1)}ms
            </dd>
          </div>
          <div>
            <dt>Timestamp drop / Resync</dt>
            <dd data-testid="sync-drops">
              {snapshot.metrics.timestampDrops} / {snapshot.metrics.resyncs}
            </dd>
          </div>
        </dl>
      </section>
    </section>
  );
}
