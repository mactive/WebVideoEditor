import type {
  JsHeapMetrics,
  MediaProxyProgress,
  MediaProxyResult,
  ProxyPcmSampleCountDiagnostics,
  ProxyCacheStats,
  StorageEstimateMetrics,
} from "@web-video-editor/media-runtime";
import {
  sampleJsHeapMetrics,
  sampleStorageEstimate,
} from "@web-video-editor/media-runtime";
import { useEffect, useState } from "react";

import "./ProxyProgress.css";

type ExtendedProxyTelemetry = MediaProxyProgress & {
  committedBytes?: number;
  heap?: JsHeapMetrics;
  opfsCommittedBytes?: number;
  opfsTemporaryBytes?: number;
  storageEstimate?: StorageEstimateMetrics;
  temporaryBytes?: number;
  temporaryEntries?: number;
  workerHeap?: JsHeapMetrics;
};

export type ProxyProgressState = {
  error?: string;
  progress?: MediaProxyProgress;
  ratio: number;
  result?: MediaProxyResult;
  status: "cancelled" | "failed" | "queued" | "ready" | "running";
};

export type ProxyProgressProps = {
  onCancel?: () => void;
  onRetry?: () => void;
  state: ProxyProgressState;
};

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return "0 KiB";
  }
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

function formatMaybeBytes(bytes: number | undefined): string {
  return bytes === undefined ? "N/A" : formatBytes(bytes);
}

function formatPercent(ratio: number): string {
  return `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
}

function formatTime(seconds: number): string {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remaining = rounded % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatRate(bytes: number, elapsedMs: number): string {
  if (bytes <= 0 || elapsedMs <= 0) {
    return "等待写入";
  }
  return `${formatBytes(bytes / (elapsedMs / 1000))}/s`;
}

function dimensions(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}×${height}` : "等待元数据";
}

function storageText(storage: StorageEstimateMetrics | undefined): string {
  return storage?.available
    ? `${formatMaybeBytes(storage.usageBytes)} / ${formatMaybeBytes(storage.quotaBytes)}`
    : "N/A";
}

function heapText(heap: JsHeapMetrics | undefined): string {
  const limit = heap?.jsHeapSizeLimit ?? heap?.totalJSHeapSize;
  if (!heap?.available) {
    return "N/A";
  }
  return limit
    ? `${formatMaybeBytes(heap.usedJSHeapSize)} / ${formatMaybeBytes(limit)}`
    : formatMaybeBytes(heap.usedJSHeapSize);
}

function pcmDiagnosticsText(
  diagnostics: ProxyPcmSampleCountDiagnostics,
): string {
  return `expected ${diagnostics.expected} · received ${diagnostics.received} · delta ${diagnostics.delta} · tolerance ${diagnostics.tolerance} · ${diagnostics.strategy}`;
}

function stageDetail(progress: ExtendedProxyTelemetry | undefined): string {
  switch (progress?.stage) {
    case "cache":
      return "检查 OPFS cache key";
    case "thumbnails":
      return "抽样生成 cover/thumbnails WebP";
    case "transcode":
      return "读取 sample 并写入 proxy.mp4";
    case "waveform":
      return "音频 PCM 聚合 waveform.f32";
    case "keyframes":
      return "汇总编码关键帧索引";
    case "commit":
      return "提交 OPFS manifest 和产物";
    case "completed":
      return "完成或命中缓存";
    case undefined:
      return "等待 worker 回传";
  }
}

function keyframeText(result: MediaProxyResult | undefined): string {
  const keyframes = result?.manifest.keyframes ?? [];
  if (keyframes.length === 0) {
    return "等待 keyframe 索引";
  }
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  const interval =
    keyframes.length > 1
      ? (last.timestampSec - first.timestampSec) / (keyframes.length - 1)
      : 0;
  return `first ${formatTime(first.timestampSec)} seq ${first.sequenceNumber} ${formatBytes(first.byteLength)} · last ${formatTime(last.timestampSec)} seq ${last.sequenceNumber} ${formatBytes(last.byteLength)} · avg ${interval.toFixed(2)}s`;
}

function opfsStats(
  result: MediaProxyResult | undefined,
  progress: ExtendedProxyTelemetry | undefined,
):
  | Pick<
      ProxyCacheStats,
      "committedBytes" | "temporaryBytes" | "temporaryEntries"
    >
  | undefined {
  if (result) {
    return result.cache;
  }
  const committedBytes =
    progress?.opfsCommittedBytes ?? progress?.committedBytes;
  const temporaryBytes =
    progress?.opfsTemporaryBytes ?? progress?.temporaryBytes;
  if (
    committedBytes === undefined &&
    temporaryBytes === undefined &&
    progress?.temporaryEntries === undefined
  ) {
    return undefined;
  }
  return {
    committedBytes: committedBytes ?? 0,
    temporaryBytes: temporaryBytes ?? 0,
    temporaryEntries: progress?.temporaryEntries ?? 0,
  };
}

export function ProxyProgress({
  onCancel,
  onRetry,
  state,
}: ProxyProgressProps) {
  const [mainThreadMetrics, setMainThreadMetrics] = useState<{
    heap: JsHeapMetrics;
    storage: StorageEstimateMetrics;
  }>(() => ({
    heap: sampleJsHeapMetrics(),
    storage: { available: false },
  }));
  const progress = state.progress as ExtendedProxyTelemetry | undefined;
  const result = state.result;
  const elapsedMs = result?.elapsedMs ?? progress?.elapsedMs ?? 0;
  const cacheStatus =
    result?.cache.status ?? progress?.cacheStatus ?? "pending";
  const outputBytes =
    result?.manifest.proxy.byteLength ?? progress?.outputBytes ?? 0;
  const processedTimeSec =
    progress?.processedTimeSec ?? result?.manifest.proxy.durationSec;
  const durationSec =
    progress?.durationSec ?? result?.manifest.source.durationSec;
  const processedRatio =
    processedTimeSec !== undefined &&
    durationSec !== undefined &&
    durationSec > 0
      ? processedTimeSec / durationSec
      : state.ratio;
  const opfs = opfsStats(result, progress);
  const storage =
    progress?.storageEstimate ??
    result?.cache.storageEstimate ??
    mainThreadMetrics.storage;
  const workerHeap = progress?.workerHeap ?? progress?.heap;
  const pcmDiagnostics =
    progress?.pcmSampleCount ?? result?.manifest.diagnostics?.pcmSampleCount;

  useEffect(() => {
    let active = true;
    const sample = () => {
      const heap = sampleJsHeapMetrics();
      void sampleStorageEstimate().then((storageEstimate) => {
        if (active) {
          setMainThreadMetrics({ heap, storage: storageEstimate });
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

  return (
    <section
      aria-label="代理生成进度"
      className="proxy-progress"
      data-status={state.status}
    >
      <div className="proxy-progress__header">
        <strong>PROXY PIPELINE</strong>
        <span>{state.status.toUpperCase()}</span>
      </div>
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(state.ratio * 100)}
        className="proxy-progress__track"
        role="progressbar"
      >
        <span style={{ width: `${Math.round(state.ratio * 100)}%` }} />
      </div>
      <dl>
        <div>
          <dt>阶段</dt>
          <dd>
            {progress?.stage ?? state.status} · {stageDetail(progress)}
          </dd>
        </div>
        <div>
          <dt>缓存</dt>
          <dd>{cacheStatus.toUpperCase()}</dd>
        </div>
        <div>
          <dt>尺寸</dt>
          <dd>
            {dimensions(progress?.inputWidth, progress?.inputHeight)} →{" "}
            {dimensions(
              result?.manifest.proxy.width ?? progress?.outputWidth,
              result?.manifest.proxy.height ?? progress?.outputHeight,
            )}
          </dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{outputBytes > 0 ? formatBytes(outputBytes) : "等待编码"}</dd>
        </div>
        <div>
          <dt>进度</dt>
          <dd>
            pipeline {formatPercent(state.ratio)} · media{" "}
            {formatPercent(processedRatio)}
          </dd>
        </div>
        {processedTimeSec !== undefined && durationSec !== undefined ? (
          <div>
            <dt>处理</dt>
            <dd>
              {formatTime(processedTimeSec)} / {formatTime(durationSec)}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>耗时</dt>
          <dd>{(elapsedMs / 1000).toFixed(2)}s</dd>
        </div>
        <div>
          <dt>写入速率</dt>
          <dd>{formatRate(outputBytes, elapsedMs)}</dd>
        </div>
        <div>
          <dt>OPFS</dt>
          <dd>
            committed {formatMaybeBytes(opfs?.committedBytes)} · temp{" "}
            {formatMaybeBytes(opfs?.temporaryBytes)} · entries{" "}
            {opfs?.temporaryEntries ?? "N/A"}
          </dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>{storageText(storage)}</dd>
        </div>
        <div>
          <dt>Main Heap</dt>
          <dd>{heapText(mainThreadMetrics.heap)}</dd>
        </div>
        <div>
          <dt>Worker Heap</dt>
          <dd>
            {workerHeap?.available
              ? `${heapText(workerHeap)}（估计/回传）`
              : "不可用（Worker heap 未稳定暴露）"}
          </dd>
        </div>
        {pcmDiagnostics ? (
          <div>
            <dt>PCM</dt>
            <dd>{pcmDiagnosticsText(pcmDiagnostics)}</dd>
          </div>
        ) : null}
        {result ? (
          <>
            <div>
              <dt>产物</dt>
              <dd>
                {result.manifest.thumbnails.length} thumbnails ·{" "}
                {result.manifest.keyframes.length} keyframes ·{" "}
                {result.manifest.waveform.bucketCount} waveform buckets
              </dd>
            </div>
            <div>
              <dt>Keyframe</dt>
              <dd>{keyframeText(result)}</dd>
            </div>
            <div>
              <dt>Cache</dt>
              <dd>
                {formatBytes(result.cache.committedBytes)} ·{" "}
                {result.cache.entries} entries · temp{" "}
                {result.cache.temporaryEntries}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {state.error ? (
        <p className="proxy-progress__error">{state.error}</p>
      ) : null}
      {state.status === "queued" || state.status === "running" ? (
        <button onClick={onCancel} type="button">
          取消代理
        </button>
      ) : null}
      {state.status === "failed" || state.status === "cancelled" ? (
        <button onClick={onRetry} type="button">
          重试代理
        </button>
      ) : null}
    </section>
  );
}
