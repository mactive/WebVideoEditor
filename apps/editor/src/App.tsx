import type { Asset, ProjectCommand } from "@web-video-editor/domain";
import type {
  BrowserMediaSource,
  MediaProbeResult,
  MediaProxyResult,
  PlaybackMediaSource,
} from "@web-video-editor/media-runtime";
import {
  ConsoleLogSink,
  LogHub,
  StructuredLogger,
  type LogEntry,
} from "@web-video-editor/observability";
import type { PreviewSource } from "@web-video-editor/preview-runtime";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { SyncDebugPanel } from "./audio/SyncDebugPanel";
import {
  detectCapabilities,
  getActionAvailability,
  logCapabilityReport,
  type ActionAvailability,
  type CapabilityReport,
  type EditorAction,
} from "./capabilities";
import { ExportPanel } from "./export/ExportPanel";
import { Inspector } from "./inspector/Inspector";
import { LogPanel } from "./logs/LogPanel";
import { MediaPanel } from "./media/MediaPanel";
import { PreviewPanel } from "./preview/PreviewPanel";
import {
  ProjectCommandController,
  clipSelected,
  createEditorStore,
  playheadChanged,
  textSelected,
} from "./store";
import { Timeline } from "./timeline/Timeline";
import {
  appendTimelineStartUs,
  projectDurationUs,
} from "./timeline/timelineMath";

type RuntimeSource = {
  audio: PlaybackMediaSource;
  preview: PreviewSource;
};

type DebugTab = "capabilities" | "json" | "logs" | "sync";

declare global {
  interface Window {
    __TASK_14_RUNTIME__?: {
      getLogs(): readonly LogEntry[];
    };
  }
}

function directRuntimeSource(
  asset: Asset,
  result: MediaProbeResult,
  source: BrowserMediaSource,
  mediaUrl: string,
): RuntimeSource {
  const video = result.videoTracks.find(
    (track) => track.trackId === result.primaryVideoTrackId,
  );
  if (!video) {
    throw new Error(`素材 "${asset.name}" 缺少主视频轨`);
  }
  return {
    audio:
      source.kind === "blob" || source.kind === "file"
        ? { blob: source.blob, kind: "blob" }
        : { kind: "url", url: mediaUrl },
    preview: {
      assetId: asset.id,
      cacheKey: `source-${asset.fingerprint}`,
      cacheStatus: "miss",
      frameRate: video.frameRate,
      height: video.displayHeight,
      keyframes: [],
      mediaUrl,
      width: video.displayWidth,
    },
  };
}

function proxyRuntimeSource(
  asset: Asset,
  result: MediaProxyResult,
): RuntimeSource {
  return {
    audio: {
      cacheKey: result.manifest.cacheKey,
      kind: "opfs-proxy",
      path: result.manifest.proxy.path,
    },
    preview: {
      assetId: asset.id,
      cacheStatus: result.cache.status,
      keyframes: result.manifest.keyframes,
      manifest: result.manifest,
    },
  };
}

export function App() {
  const [report, setReport] = useState<CapabilityReport>();
  const [failure, setFailure] = useState<string>();
  const [status, setStatus] = useState("导入真实素材后添加到时间线");
  const [debugTab, setDebugTab] = useState<DebugTab>("logs");
  const [structuredLoggingEnabled, setStructuredLoggingEnabled] =
    useState(true);
  const [runtimeSources, setRuntimeSources] = useState<
    Record<string, RuntimeSource>
  >({});
  const [originalSources, setOriginalSources] = useState<
    Record<string, BrowserMediaSource>
  >({});
  const objectUrlsRef = useRef(new Set<string>());
  const logHub = useMemo(() => new LogHub([new ConsoleLogSink()]), []);
  const commandLogger = useMemo(
    () => new StructuredLogger(logHub, "editor-command"),
    [logHub],
  );
  const capabilityLogger = useMemo(
    () => new StructuredLogger(logHub, "editor-bootstrap"),
    [logHub],
  );
  const editorStore = useMemo(() => createEditorStore(), []);
  const commandController = useMemo(
    () =>
      new ProjectCommandController(editorStore, {
        onEvent: (event) => {
          commandLogger.log({
            event:
              event.action === "undo"
                ? "undo.completed"
                : event.action === "redo"
                  ? "redo.completed"
                  : "execution.completed",
            input: {
              commandTypes: event.commandTypes,
              transactionId: event.transactionId,
            },
            level: "info",
            marker: "[COMMAND]",
            output: {
              afterRevision: event.afterRevision,
              beforeRevision: event.beforeRevision,
            },
            projectRevision: event.afterRevision,
            requestId: event.transactionId,
          });
        },
      }),
    [commandLogger, editorStore],
  );
  const state = useSyncExternalStore(
    editorStore.subscribe,
    editorStore.getState,
    editorStore.getState,
  );
  const { document: project } = state.project;
  const { playheadUs, selectedClipId, selectedTextId } = state.session;
  const actions = useMemo(
    () =>
      new Map<EditorAction, ActionAvailability>(
        report
          ? getActionAvailability(report).map((action) => [action.id, action])
          : [],
      ),
    [report],
  );
  const previewSources = useMemo(
    () => Object.values(runtimeSources).map((source) => source.preview),
    [runtimeSources],
  );
  const audioSources = useMemo(
    () =>
      new Map(
        Object.entries(runtimeSources).map(([assetId, source]) => [
          assetId,
          source.audio,
        ]),
      ),
    [runtimeSources],
  );

  useEffect(() => {
    logHub.setEnabled(structuredLoggingEnabled);
  }, [logHub, structuredLoggingEnabled]);

  useEffect(() => {
    let active = true;
    const startedAt = performance.now();
    void detectCapabilities()
      .then((nextReport) => {
        if (!active) {
          return;
        }
        setReport(nextReport);
        logCapabilityReport(
          capabilityLogger,
          nextReport,
          getActionAvailability(nextReport),
          performance.now() - startedAt,
        );
      })
      .catch((error: unknown) => {
        if (active) {
          setFailure(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [capabilityLogger]);

  useEffect(() => () => commandController.dispose(), [commandController]);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      objectUrlsRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    window.__TASK_14_RUNTIME__ = {
      getLogs: () => logHub.getEntries(),
    };
    return () => {
      delete window.__TASK_14_RUNTIME__;
    };
  }, [logHub]);

  const execute = (command: ProjectCommand, transactionId?: string) => {
    try {
      commandController.execute(
        command,
        transactionId ? { transactionId } : undefined,
      );
      setStatus(`已执行 ${command.type}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`操作未提交：${message}`);
      commandLogger.log({
        error,
        event: "execution.failed",
        input: { command },
        level: "error",
        marker: "[COMMAND]",
        projectRevision: editorStore.getState().project.document.revision,
      });
    }
  };

  const importAsset = (
    asset: Asset,
    result: MediaProbeResult,
    source: BrowserMediaSource,
  ) => {
    const current = editorStore.getState().project.document;
    if (!current.assets.some((existing) => existing.id === asset.id)) {
      execute({
        adaptCanvasToAsset:
          current.assets.length === 0 &&
          current.canvas.width === 1920 &&
          current.canvas.height === 1080,
        asset,
        type: "asset.add",
      });
    }
    const mediaUrl =
      source.kind === "blob" || source.kind === "file"
        ? URL.createObjectURL(source.blob)
        : "url" in source
          ? source.url
          : "";
    if (mediaUrl.startsWith("blob:")) {
      objectUrlsRef.current.add(mediaUrl);
    }
    setRuntimeSources((sources) => ({
      ...sources,
      [asset.id]: directRuntimeSource(asset, result, source, mediaUrl),
    }));
    setOriginalSources((sources) => ({
      ...sources,
      [asset.id]: source,
    }));
    setStatus(`${asset.name} 已导入，可立即添加并用原素材预览`);
  };

  const addToTimeline = (assetId: string) => {
    const current = editorStore.getState().project.document;
    const asset = current.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      setStatus("素材尚未完成探测");
      return;
    }
    const clipId = `clip-${crypto.randomUUID()}`;
    execute({
      clip: {
        assetId,
        effects: [],
        id: clipId,
        sourceEndUs: asset.durationUs,
        sourceStartUs: 0,
        timelineStartUs: appendTimelineStartUs(current),
        trackId: "video-track",
        transform: {
          rotationDeg: 0,
          scale: 1,
          x: 0.5,
          y: 0.5,
        },
      },
      type: "clip.add",
    });
    editorStore.dispatch(clipSelected(clipId));
  };

  const addTitle = () => {
    const current = editorStore.getState().project.document;
    const startUs = editorStore.getState().session.playheadUs;
    const textId = `title-${crypto.randomUUID()}`;
    execute({
      text: {
        color: "#ffffff",
        endUs: Math.max(startUs + 5_000_000, projectDurationUs(current)),
        fontSize: 64,
        id: textId,
        rotationDeg: 0,
        scale: 1,
        startUs,
        text: "输入标题",
        trackId: "text-track",
        x: 0.5,
        y: 0.15,
      },
      type: "text.add",
    });
    editorStore.dispatch(textSelected(textId));
  };

  const splitSelected = () => {
    if (!selectedClipId) {
      return;
    }
    execute({
      clipId: selectedClipId,
      rightClipId: `clip-${crypto.randomUUID()}`,
      timelineUs: playheadUs,
      type: "clip.split",
    });
  };

  const deleteSelected = () => {
    if (selectedClipId) {
      execute({ clipId: selectedClipId, type: "clip.delete" });
      editorStore.dispatch(clipSelected(null));
    } else if (selectedTextId) {
      execute({ textId: selectedTextId, type: "text.delete" });
      editorStore.dispatch(textSelected(null));
    }
  };

  const undo = () => {
    commandController.undo();
    setStatus("已 Undo");
  };
  const redo = () => {
    commandController.redo();
    setStatus("已 Redo");
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <main className="editor">
      <header className="editor__header">
        <div>
          <p className="eyebrow">WEB VIDEO LAB · TASK 11</p>
          <h1>总编辑器</h1>
          <p>真实素材 → Command Bus → Redux Project → ECS → PixiJS</p>
        </div>
        <nav>
          <span>REV {project.revision}</span>
          <a href="/mobx.html">MobX 对照实验</a>
          <a href="/sync-debug.html">A/V 独立调试</a>
        </nav>
      </header>

      <p className="editor__status" aria-live="polite">
        {status}
      </p>

      <div className="editor__workspace">
        <div className="editor__media">
          <MediaPanel
            actionAvailability={actions.get("import")}
            logHub={logHub}
            onAddToTimeline={addToTimeline}
            onAssetImported={importAsset}
            onProxyReady={(asset, result) =>
              setRuntimeSources((sources) => ({
                ...sources,
                [asset.id]: proxyRuntimeSource(asset, result),
              }))
            }
            projectAssets={project.assets}
            timelineAssetIds={project.clips.map((clip) => clip.assetId)}
          />
        </div>
        <div className="editor__preview">
          <PreviewPanel
            actionAvailability={actions.get("preview")}
            audioSources={audioSources}
            diagnosticsLoggingEnabled={structuredLoggingEnabled}
            embedded
            logHub={logHub}
            onPlayheadChange={(nextPlayheadUs) => {
              if (
                editorStore.getState().session.playheadUs !== nextPlayheadUs
              ) {
                editorStore.dispatch(playheadChanged(nextPlayheadUs));
              }
            }}
            playheadUs={playheadUs}
            project={project}
            sources={previewSources}
          />
        </div>
        <Inspector
          onExecute={execute}
          project={project}
          selectedClipId={selectedClipId}
          selectedTextId={selectedTextId}
        />
      </div>

      <Timeline
        canRedo={commandController.canRedo}
        canUndo={commandController.canUndo}
        onAddTitle={addTitle}
        onDelete={deleteSelected}
        onEdit={(edit, transactionId) => execute(edit, transactionId)}
        onPlayheadChange={(nextPlayheadUs) =>
          editorStore.dispatch(playheadChanged(nextPlayheadUs))
        }
        onRedo={redo}
        onSelectClip={(clipId) => editorStore.dispatch(clipSelected(clipId))}
        onSelectText={(textId) => editorStore.dispatch(textSelected(textId))}
        onSplit={splitSelected}
        onUndo={undo}
        playheadUs={playheadUs}
        project={project}
        selectedClipId={selectedClipId}
        selectedTextId={selectedTextId}
      />

      <ExportPanel
        actionAvailability={actions.get("export")}
        logHub={logHub}
        project={project}
        sources={originalSources}
      />

      <section className="editor__debug" aria-label="调试面板">
        <nav aria-label="调试视图">
          {(
            [
              ["logs", "结构化日志"],
              ["json", "Project JSON"],
              ["capabilities", "能力"],
              ["sync", "SyncDebugPanel"],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-pressed={debugTab === id}
              disabled={
                id === "sync" && actions.get("sharedMemory")?.enabled !== true
              }
              key={id}
              onClick={() => setDebugTab(id)}
              title={
                id === "sync" ? actions.get("sharedMemory")?.reason : undefined
              }
              type="button"
            >
              {label}
            </button>
          ))}
          <button
            aria-pressed={structuredLoggingEnabled}
            data-testid="structured-log-toggle"
            onClick={() =>
              setStructuredLoggingEnabled((enabled) => !enabled)
            }
            type="button"
          >
            日志{structuredLoggingEnabled ? "开启" : "关闭"}
          </button>
        </nav>
        <p className="editor__debug-status">
          结构化日志：{structuredLoggingEnabled ? "开启" : "关闭"}；关闭后不再写入总日志、Console 或预览 Worker 日志回传。
        </p>
        {actions.get("sharedMemory")?.enabled === false ? (
          <p data-testid="shared-memory-diagnosis" role="alert">
            共享内存实验已禁用：
            {actions.get("sharedMemory")?.reason}
          </p>
        ) : null}
        {debugTab === "logs" ? (
          <LogPanel source={logHub} title="总编辑器结构化日志" />
        ) : null}
        {debugTab === "json" ? (
          <pre data-testid="project-json">
            {JSON.stringify(project, null, 2)}
          </pre>
        ) : null}
        {debugTab === "capabilities" ? (
          <div className="editor__capabilities">
            {failure ? <p role="alert">{failure}</p> : null}
            {report?.results.map((item) => (
              <span
                data-capability-id={item.id}
                data-supported={item.supported}
                key={item.id}
              >
                {item.label}: {item.supported ? "YES" : "NO"}
              </span>
            )) ?? <span>检测中…</span>}
          </div>
        ) : null}
        {debugTab === "sync" ? (
          <SyncDebugPanel
            actionAvailability={actions.get("sharedMemory")}
            embedded
          />
        ) : null}
      </section>
    </main>
  );
}
