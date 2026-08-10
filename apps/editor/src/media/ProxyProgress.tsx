import type {
  MediaProxyProgress,
  MediaProxyResult,
} from "@web-video-editor/media-runtime";

import "./ProxyProgress.css";

export type ProxyProgressState = {
  error?: string;
  progress?: MediaProxyProgress;
  ratio: number;
  result?: MediaProxyResult;
  status: "cancelled" | "failed" | "queued" | "ready" | "running";
};

export type ProxyProgressProps = {
  onCancel?: () => void;
  state: ProxyProgressState;
};

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.ceil(bytes / 1024)} KiB`;
}

function dimensions(
  width: number | undefined,
  height: number | undefined,
): string {
  return width && height ? `${width}×${height}` : "等待元数据";
}

export function ProxyProgress({ onCancel, state }: ProxyProgressProps) {
  const progress = state.progress;
  const result = state.result;
  const elapsedMs = result?.elapsedMs ?? progress?.elapsedMs ?? 0;
  const cacheStatus =
    result?.cache.status ?? progress?.cacheStatus ?? "pending";
  const outputBytes =
    result?.manifest.proxy.byteLength ?? progress?.outputBytes ?? 0;

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
          <dd>{progress?.stage ?? state.status}</dd>
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
          <dt>耗时</dt>
          <dd>{(elapsedMs / 1000).toFixed(2)}s</dd>
        </div>
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
              <dt>OPFS</dt>
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
    </section>
  );
}
