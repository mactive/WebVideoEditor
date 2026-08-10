import type { ProjectDocument } from "@web-video-editor/domain";
import type { BrowserMediaSource } from "@web-video-editor/media-runtime";
import {
  BoundedTaskQueue,
  WorkerClient,
  type QueueStats,
  type ScheduledTaskHandle,
} from "@web-video-editor/media-runtime";
import { LogHub, StructuredLogger } from "@web-video-editor/observability";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ActionAvailability } from "../capabilities";
import { inspectExportFile } from "./export-inspection";
import { getExportFile } from "./export-opfs";
import {
  MEDIA_EXPORT_OPERATION,
  type MediaExportProgress,
  type MediaExportRequest,
  type MediaExportResult,
} from "./export-types";

import "./ExportPanel.css";

type ExportStatus = "cancelled" | "completed" | "failed" | "idle" | "running";

export type ExportPanelProps = {
  actionAvailability?: ActionAvailability;
  logHub: LogHub;
  project: ProjectDocument;
  sources: Readonly<Record<string, BrowserMediaSource>>;
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  return `${Math.ceil(bytes / 1024)} KiB`;
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "—";
  }
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ExportPanel({
  actionAvailability,
  logHub,
  project,
  sources,
}: ExportPanelProps) {
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [progress, setProgress] = useState<MediaExportProgress | null>(null);
  const [result, setResult] = useState<MediaExportResult | null>(null);
  const [error, setError] = useState<string>();
  const [downloadUrl, setDownloadUrl] = useState<string>();
  const taskRef = useRef<
    ScheduledTaskHandle<MediaExportResult, MediaExportProgress> | undefined
  >(undefined);
  const resultRef = useRef<MediaExportResult | null>(null);
  const progressRef = useRef<MediaExportProgress | null>(null);
  const downloadUrlRef = useRef<string | undefined>(undefined);
  const client = useMemo(
    () =>
      new WorkerClient({
        defaultTimeoutMs: 60 * 60_000,
        logger: new StructuredLogger(logHub, "export-panel"),
        workerFactory: () =>
          new Worker(new URL("./export.worker.ts", import.meta.url), {
            name: "export-worker",
            type: "module",
          }),
        workerLogSink: logHub,
      }),
    [logHub],
  );
  const queue = useMemo(
    () =>
      new BoundedTaskQueue(client, {
        concurrency: 1,
        highWatermark: 1,
        logger: new StructuredLogger(logHub, "export-task-queue"),
        marker: "[EXPORT]",
        operation: MEDIA_EXPORT_OPERATION,
      }),
    [client, logHub],
  );
  const [taskQueue, setTaskQueue] = useState<QueueStats>(() => queue.stats());
  const missingSources = project.clips
    .map((clip) => clip.assetId)
    .filter((assetId, index, all) => all.indexOf(assetId) === index)
    .filter((assetId) => !sources[assetId]);
  const canStart =
    status !== "running" &&
    project.clips.length > 0 &&
    missingSources.length === 0 &&
    actionAvailability?.enabled === true;

  const replaceDownloadUrl = useCallback((next?: string) => {
    if (downloadUrlRef.current) {
      URL.revokeObjectURL(downloadUrlRef.current);
    }
    downloadUrlRef.current = next;
    setDownloadUrl(next);
  }, []);

  const start = useCallback(() => {
    if (
      taskRef.current ||
      project.clips.length === 0 ||
      missingSources.length > 0 ||
      actionAvailability?.enabled !== true
    ) {
      return;
    }
    replaceDownloadUrl();
    setError(undefined);
    setResult(null);
    resultRef.current = null;
    setProgress(null);
    progressRef.current = null;
    setStatus("running");
    const task = queue.schedule<
      MediaExportRequest,
      MediaExportResult,
      MediaExportProgress
    >(
      project.revision,
      {
        project,
        sources: [...new Set(project.clips.map((clip) => clip.assetId))].map(
          (assetId) => ({ assetId, source: sources[assetId]! }),
        ),
      },
      {
        requestId: `export_${crypto.randomUUID()}`,
        timeoutMs: 60 * 60_000,
      },
    );
    taskRef.current = task;
    task.progress$.subscribe(({ payload }) => {
      if (!payload) {
        return;
      }
      progressRef.current = payload;
      setProgress(payload);
    });
    void task.result.then(
      async (nextResult) => {
        if (taskRef.current !== task) {
          return;
        }
        taskRef.current = undefined;
        resultRef.current = nextResult;
        setResult(nextResult);
        setStatus("completed");
        const file = await getExportFile(nextResult);
        replaceDownloadUrl(URL.createObjectURL(file));
      },
      (reason: unknown) => {
        if (taskRef.current !== task) {
          return;
        }
        taskRef.current = undefined;
        const cancelled =
          reason instanceof DOMException && reason.name === "AbortError";
        setStatus(cancelled ? "cancelled" : "failed");
        setError(
          cancelled ? "导出已取消，临时文件正在清理" : errorMessage(reason),
        );
      },
    );
  }, [
    actionAvailability?.enabled,
    missingSources.length,
    project,
    queue,
    replaceDownloadUrl,
    sources,
  ]);

  const cancel = useCallback(() => {
    taskRef.current?.cancel("用户取消导出");
  }, []);

  useEffect(
    () => () => {
      taskRef.current?.cancel("导出面板已卸载");
      queue.dispose();
      client.dispose();
      if (downloadUrlRef.current) {
        URL.revokeObjectURL(downloadUrlRef.current);
      }
    },
    [client, queue],
  );

  useEffect(() => {
    const subscription = queue.events$.subscribe(() => {
      queueMicrotask(() => setTaskQueue(queue.stats()));
    });
    return () => subscription.unsubscribe();
  }, [queue]);

  useEffect(() => {
    window.__TASK_11_EXPORT__ = {
      cancel,
      getFile: async () =>
        resultRef.current ? getExportFile(resultRef.current) : null,
      getProgress: () => progressRef.current,
      getResult: () => resultRef.current,
      getTaskQueue: () => queue.stats(),
      inspectFile: async () =>
        resultRef.current
          ? inspectExportFile(await getExportFile(resultRef.current))
          : null,
      start,
    };
    return () => {
      delete window.__TASK_11_EXPORT__;
    };
  }, [cancel, queue, start]);

  return (
    <section
      aria-labelledby="export-title"
      className="export-panel"
      data-export-status={status}
      data-output-bytes={result?.bytes ?? progress?.outputBytes ?? 0}
      data-processed-frames={progress?.processedFrames ?? 0}
      data-testid="export-panel"
    >
      <div className="export-panel__heading">
        <div>
          <p className="eyebrow">ORIGINAL SOURCE · TASK 11</p>
          <h2 id="export-title">高质量 MP4 导出</h2>
          <p>Export Worker · ECS · OffscreenCanvas · WebCodecs · Mediabunny</p>
        </div>
        <strong data-testid="export-source">source=original</strong>
      </div>

      <dl className="export-panel__settings">
        <div>
          <dt>输出</dt>
          <dd>
            {project.exportSettings.width}×{project.exportSettings.height} ·{" "}
            {project.exportSettings.frameRate} FPS
          </dd>
        </div>
        <div>
          <dt>编码</dt>
          <dd>H.264 / AAC · MP4 fragmented stream</dd>
        </div>
        <div>
          <dt>临时存储</dt>
          <dd>OPFS · 4 MiB chunk · 不聚合整文件内存</dd>
        </div>
      </dl>

      <div className="export-panel__progress">
        <progress
          aria-label="导出进度"
          max={progress?.totalFrames ?? 1}
          value={progress?.processedFrames ?? 0}
        />
        <span data-testid="export-stage">{progress?.stage ?? status}</span>
        <span>
          {progress?.processedFrames ?? 0}/{progress?.totalFrames ?? 0} 帧
        </span>
        <span>ETA {formatDuration(progress?.etaMs ?? 0)}</span>
        <span>VQ {progress?.videoQueue ?? 0}</span>
        <span>AQ {progress?.audioQueue ?? 0}</span>
        <span data-testid="export-task-queue">
          Task {taskQueue.active}/{taskQueue.queued} · HWM{" "}
          {taskQueue.highWatermark}
        </span>
        <span>
          VF/AD{" "}
          {progress
            ? `${progress.resources.byType["video-frame"].active}/${progress.resources.byType["audio-data"].active}`
            : "0/0"}
        </span>
        <span>
          Heap{" "}
          {progress?.heap.available
            ? formatBytes(progress.heap.usedJSHeapSize ?? 0)
            : "N/A"}
        </span>
        <span>{formatBytes(result?.bytes ?? progress?.outputBytes ?? 0)}</span>
      </div>

      {error ? (
        <p className="export-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {!actionAvailability ? (
        <p className="export-panel__diagnosis">正在检测 H.264/AAC 编码能力…</p>
      ) : actionAvailability.enabled !== true ? (
        <p className="export-panel__diagnosis" role="alert">
          {actionAvailability.reason}
        </p>
      ) : missingSources.length > 0 ? (
        <p className="export-panel__diagnosis" role="alert">
          缺少原素材 source：{missingSources.join(", ")}。代理禁止导出。
        </p>
      ) : project.clips.length === 0 ? (
        <p className="export-panel__diagnosis">先将素材添加到时间线。</p>
      ) : null}

      {result ? (
        <p className="export-panel__result" data-testid="export-result">
          {result.frames} 帧 · {formatBytes(result.bytes)} ·{" "}
          {formatDuration(result.elapsedMs)} · {result.audioFrames} audio frames
          · peak VF/AD {result.resources.byType["video-frame"].peak}/
          {result.resources.byType["audio-data"].peak}
        </p>
      ) : null}

      <div className="export-panel__actions">
        <button disabled={!canStart} onClick={start} type="button">
          {status === "failed" || status === "cancelled"
            ? "重新导出"
            : "开始导出"}
        </button>
        <button disabled={status !== "running"} onClick={cancel} type="button">
          取消导出
        </button>
        {downloadUrl && result ? (
          <a download={result.fileName} href={downloadUrl}>
            下载 MP4
          </a>
        ) : null}
      </div>
    </section>
  );
}
