import {
  DEFAULT_TEXT_BACKGROUND_COLOR,
  DEFAULT_TEXT_BACKGROUND_OPACITY,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_STROKE_COLOR,
  DEFAULT_TEXT_STROKE_WIDTH,
  MIN_TEXT_DURATION_US,
  type Asset,
  type ProjectCommand,
  type ProjectDocument,
} from "@web-video-editor/domain";
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
  type CSSProperties,
  useEffect,
  useMemo,
  type PointerEvent,
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
import {
  MediaPanel,
  type TimelineAddContext,
  type TimelineAddKind,
  type TimelineAddOptions,
} from "./media/MediaPanel";
import { PreviewPanel } from "./preview/PreviewPanel";
import {
  ProjectCommandController,
  clipSelected,
  createEditorStore,
  playheadChanged,
  targetAudioTrackSelected,
  targetTextTrackSelected,
  targetVideoTrackSelected,
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

const TOP_WORKSPACE_DEFAULT_HEIGHT_PX = 570;
const TOP_WORKSPACE_MIN_HEIGHT_PX = 280;
const TOP_WORKSPACE_MAX_HEIGHT_PX = 780;
const TOP_WORKSPACE_COLLAPSED_HEIGHT_PX = 260;
const DEFAULT_TEXT_DURATION_US = 5_000_000;

function clampTopWorkspaceHeight(value: number): number {
  return Math.max(
    TOP_WORKSPACE_MIN_HEIGHT_PX,
    Math.min(TOP_WORKSPACE_MAX_HEIGHT_PX, Math.round(value)),
  );
}

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

function tracksInOrder(
  project: ProjectDocument,
  kind: ProjectDocument["tracks"][number]["kind"],
) {
  return project.tracks
    .filter((track) => track.kind === kind)
    .sort((left, right) => left.order - right.order);
}

function resolveTargetTrackId(
  project: ProjectDocument,
  kind: ProjectDocument["tracks"][number]["kind"],
  preferredTrackId: string | null,
): string | null {
  const tracks = tracksInOrder(project, kind);
  return tracks.some((track) => track.id === preferredTrackId)
    ? preferredTrackId
    : (tracks[0]?.id ?? null);
}

function isEditorShortcutInputTarget(target: EventTarget | null): boolean {
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

export type AppProps = {
  initialProject?: ProjectDocument;
};

export function App({ initialProject }: AppProps = {}) {
  const [report, setReport] = useState<CapabilityReport>();
  const [failure, setFailure] = useState<string>();
  const [status, setStatus] = useState("导入真实素材后添加到时间线");
  const [debugTab, setDebugTab] = useState<DebugTab>("logs");
  const [structuredLoggingEnabled, setStructuredLoggingEnabled] =
    useState(false);
  const [topWorkspaceHeightPx, setTopWorkspaceHeightPx] = useState(
    TOP_WORKSPACE_DEFAULT_HEIGHT_PX,
  );
  const [topWorkspaceCollapsed, setTopWorkspaceCollapsed] = useState(false);
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
  const editorStore = useMemo(
    () => createEditorStore(initialProject),
    [initialProject],
  );
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
  const {
    playheadUs,
    selectedClipId,
    selectedTextId,
    targetAudioTrackId: sessionTargetAudioTrackId,
    targetTextTrackId: sessionTargetTextTrackId,
    targetVideoTrackId: sessionTargetVideoTrackId,
  } = state.session;
  const targetVideoTrackId = useMemo(
    () =>
      resolveTargetTrackId(project, "video", sessionTargetVideoTrackId),
    [project, sessionTargetVideoTrackId],
  );
  const targetAudioTrackId = useMemo(
    () =>
      resolveTargetTrackId(project, "audio", sessionTargetAudioTrackId),
    [project, sessionTargetAudioTrackId],
  );
  const targetTextTrackId = useMemo(
    () => resolveTargetTrackId(project, "text", sessionTargetTextTrackId),
    [project, sessionTargetTextTrackId],
  );
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
  const visibleTopWorkspaceHeightPx = topWorkspaceCollapsed
    ? TOP_WORKSPACE_COLLAPSED_HEIGHT_PX
    : topWorkspaceHeightPx;
  const topWorkspaceStyle = {
    "--editor-workspace-height": `${visibleTopWorkspaceHeightPx}px`,
  } as CSSProperties;
  const beginTopWorkspaceResize = (event: PointerEvent<HTMLButtonElement>) => {
    if (topWorkspaceCollapsed) {
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = topWorkspaceHeightPx;
    const resize = (moveEvent: globalThis.PointerEvent) => {
      setTopWorkspaceHeightPx(
        clampTopWorkspaceHeight(startHeight + moveEvent.clientY - startY),
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  };

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

  useEffect(() => {
    if (sessionTargetVideoTrackId !== targetVideoTrackId) {
      editorStore.dispatch(targetVideoTrackSelected(targetVideoTrackId));
    }
  }, [editorStore, sessionTargetVideoTrackId, targetVideoTrackId]);

  useEffect(() => {
    if (sessionTargetAudioTrackId !== targetAudioTrackId) {
      editorStore.dispatch(targetAudioTrackSelected(targetAudioTrackId));
    }
  }, [editorStore, sessionTargetAudioTrackId, targetAudioTrackId]);

  useEffect(() => {
    if (sessionTargetTextTrackId !== targetTextTrackId) {
      editorStore.dispatch(targetTextTrackSelected(targetTextTrackId));
    }
  }, [editorStore, sessionTargetTextTrackId, targetTextTrackId]);

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
      return true;
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
      return false;
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

  const addToTimeline = (
    assetId: string,
    addContext?: TimelineAddContext,
    options: Partial<TimelineAddOptions> = {},
  ) => {
    const current = editorStore.getState().project.document;
    const asset = current.assets.find((candidate) => candidate.id === assetId);
    if (!asset) {
      setStatus("素材尚未完成探测");
      return;
    }
    const kind = options.kind ?? "video";
    if (kind === "audio" && !asset.hasAudio) {
      setStatus("该素材没有可添加到音频轨的音频流");
      return;
    }
    const targetTrackId = resolveTargetTrackId(
      current,
      kind,
      kind === "video"
        ? editorStore.getState().session.targetVideoTrackId
        : editorStore.getState().session.targetAudioTrackId,
    );
    if (!targetTrackId) {
      setStatus(
        `当前工程没有可添加素材的${kind === "video" ? "视频" : "音频"}轨道`,
      );
      return;
    }
    const clipId = `clip-${crypto.randomUUID()}`;
    const timelineStartUs =
      options.placement === "append"
        ? appendTimelineStartUs(current, targetTrackId)
        : editorStore.getState().session.playheadUs;
    const committed = execute({
      clip: {
        assetId,
        effects: [],
        id: clipId,
        sourceEndUs: asset.durationUs,
        sourceStartUs: 0,
        timelineStartUs,
        trackId: targetTrackId,
        ...(kind === "video"
          ? {
              transform: {
                rotationDeg: 0,
                scale: 1,
                x: 0.5,
                y: 0.5,
              },
            }
          : {}),
      },
      type: "clip.add",
    });
    if (!committed) {
      return;
    }
    editorStore.dispatch(clipSelected(clipId));
    if (addContext) {
      setStatus(
        `${addContext.assetName} 已添加到${kind === "video" ? "视频" : "音频"}轨 ${options.placement === "append" ? "轨尾" : "播放头"}：${
          addContext.previewSource === "proxy"
            ? `使用 proxy 预览（cache ${addContext.cacheStatus}）。`
            : `当前使用 source fallback，proxy ${addContext.proxyStatus}；${addContext.risk}`
        }`,
      );
    }
  };

  const addMediaTrack = (kind: TimelineAddKind) => {
    const current = editorStore.getState().project.document;
    const existingTrackIds = new Set(
      tracksInOrder(current, kind).map((track) => track.id),
    );
    const command: ProjectCommand =
      kind === "video"
        ? { type: "track.video.add" }
        : { type: "track.audio.add" };
    if (!execute(command)) {
      return;
    }
    const nextProject = editorStore.getState().project.document;
    const newTrack =
      tracksInOrder(nextProject, kind).find(
        (track) => !existingTrackIds.has(track.id),
      ) ?? tracksInOrder(nextProject, kind).at(-1);
    if (newTrack) {
      editorStore.dispatch(
        kind === "video"
          ? targetVideoTrackSelected(newTrack.id)
          : targetAudioTrackSelected(newTrack.id),
      );
      setStatus(`已新增并选中 ${newTrack.name}`);
    }
  };

  const addTextTrack = () => {
    const current = editorStore.getState().project.document;
    const existingTrackIds = new Set(
      tracksInOrder(current, "text").map((track) => track.id),
    );
    if (!execute({ type: "track.text.add" })) {
      return;
    }
    const nextProject = editorStore.getState().project.document;
    const newTrack =
      tracksInOrder(nextProject, "text").find(
        (track) => !existingTrackIds.has(track.id),
      ) ?? tracksInOrder(nextProject, "text").at(-1);
    if (newTrack) {
      editorStore.dispatch(targetTextTrackSelected(newTrack.id));
      setStatus(`已新增并选中 ${newTrack.name}`);
    }
  };

  const addTitle = () => {
    const current = editorStore.getState().project.document;
    const startUs = editorStore.getState().session.playheadUs;
    const resolvedTargetTextTrackId = resolveTargetTrackId(
      current,
      "text",
      editorStore.getState().session.targetTextTrackId,
    );
    if (!resolvedTargetTextTrackId) {
      setStatus("当前工程没有可添加标题的文字轨道");
      return;
    }
    const textId = `title-${crypto.randomUUID()}`;
    const endUs = Math.max(
      startUs + MIN_TEXT_DURATION_US,
      Math.min(startUs + DEFAULT_TEXT_DURATION_US, projectDurationUs(current)),
    );
    const committed = execute({
      text: {
        backgroundColor: DEFAULT_TEXT_BACKGROUND_COLOR,
        backgroundOpacity: DEFAULT_TEXT_BACKGROUND_OPACITY,
        color: "#ffffff",
        endUs,
        fontFamily: DEFAULT_TEXT_FONT_FAMILY,
        fontSize: 64,
        id: textId,
        rotationDeg: 0,
        scale: 1,
        startUs,
        strokeColor: DEFAULT_TEXT_STROKE_COLOR,
        strokeWidth: DEFAULT_TEXT_STROKE_WIDTH,
        text: "输入文字",
        trackId: resolvedTargetTextTrackId,
        x: 0.5,
        y: 0.15,
      },
      type: "text.add",
    });
    if (committed) {
      editorStore.dispatch(textSelected(textId));
      editorStore.dispatch(targetTextTrackSelected(resolvedTargetTextTrackId));
    }
  };

  const splitSelected = () => {
    if (!selectedClipId) {
      return;
    }
    const rightClipId = `clip-${crypto.randomUUID()}`;
    const committed = execute({
      clipId: selectedClipId,
      rightClipId,
      timelineUs: playheadUs,
      type: "clip.split",
    });
    if (committed) {
      editorStore.dispatch(clipSelected(rightClipId));
    }
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

  const reorderTracks = (trackIds: string[]) => {
    execute({ trackIds, type: "track.reorder" });
  };

  const deleteTrack = (trackId: string, cascade: boolean) => {
    const before = editorStore.getState();
    const track = before.project.document.tracks.find(
      (candidate) => candidate.id === trackId,
    );
    const committed = execute({
      trackId,
      type: "track.delete",
      ...(cascade ? { cascade: true } : {}),
    });
    if (!committed) {
      return;
    }

    const nextProject = editorStore.getState().project.document;
    if (
      before.session.selectedClipId &&
      !nextProject.clips.some(
        (clip) => clip.id === before.session.selectedClipId,
      )
    ) {
      editorStore.dispatch(clipSelected(null));
    }
    if (
      before.session.selectedTextId &&
      !nextProject.texts.some(
        (text) => text.id === before.session.selectedTextId,
      )
    ) {
      editorStore.dispatch(textSelected(null));
    }
    editorStore.dispatch(
      targetVideoTrackSelected(
        resolveTargetTrackId(
          nextProject,
          "video",
          before.session.targetVideoTrackId,
        ),
      ),
    );
    editorStore.dispatch(
      targetAudioTrackSelected(
        resolveTargetTrackId(
          nextProject,
          "audio",
          before.session.targetAudioTrackId,
        ),
      ),
    );
    editorStore.dispatch(
      targetTextTrackSelected(
        resolveTargetTrackId(
          nextProject,
          "text",
          before.session.targetTextTrackId,
        ),
      ),
    );

    const nextDurationUs = projectDurationUs(nextProject);
    if (before.session.playheadUs > nextDurationUs) {
      editorStore.dispatch(playheadChanged(nextDurationUs));
    }
    setStatus(
      track
        ? `已删除轨道 ${track.name}${cascade ? " 及其内容" : ""}`
        : "已删除轨道",
    );
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
      if (isEditorShortcutInputTarget(event.target)) {
        return;
      }
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
          <h1>编辑器</h1>
          <p>真实素材 → Command Bus → Redux Project → ECS → PixiJS</p>
        </div>
        <nav>
          <span>REV {project.revision}</span>
          <a href="/docs/">文档</a>
          <a href="/opfs" target="_blank" rel="noreferrer">
            OPFS 查看器
          </a>
          <a href="/mobx.html">MobX 对照实验</a>
          <a href="/sync-debug.html">A/V 独立调试</a>
        </nav>
      </header>

      <p className="editor__status" aria-live="polite">
        {status}
      </p>

      <section className="editor__top-panel" aria-label="素材和预览区域">
        <div className="editor__top-controls">
          <div className="editor__top-summary">
            <span>上部区域</span>
            <strong>
              {topWorkspaceCollapsed
                ? "最小化"
                : `${visibleTopWorkspaceHeightPx}px`}
            </strong>
          </div>
          <label className="editor__height-control">
            <span>高度</span>
            <input
              aria-label="上部区域高度"
              disabled={topWorkspaceCollapsed}
              max={TOP_WORKSPACE_MAX_HEIGHT_PX}
              min={TOP_WORKSPACE_MIN_HEIGHT_PX}
              onChange={(event) => {
                setTopWorkspaceCollapsed(false);
                setTopWorkspaceHeightPx(
                  clampTopWorkspaceHeight(Number(event.currentTarget.value)),
                );
              }}
              step={10}
              type="range"
              value={topWorkspaceHeightPx}
            />
          </label>
          <button
            aria-expanded={!topWorkspaceCollapsed}
            onClick={() => setTopWorkspaceCollapsed((collapsed) => !collapsed)}
            type="button"
          >
            {topWorkspaceCollapsed ? "展开上部" : "最小化上部"}
          </button>
        </div>
        <div
          className={`editor__workspace${
            topWorkspaceCollapsed ? " editor__workspace--collapsed" : ""
          }`}
          data-collapsed={topWorkspaceCollapsed}
          data-testid="editor-workspace"
          style={topWorkspaceStyle}
        >
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
        <button
          aria-label="拖动调整上部区域高度"
          className="editor__workspace-resizer"
          disabled={topWorkspaceCollapsed}
          onPointerDown={beginTopWorkspaceResize}
          type="button"
        />
      </section>

      <Timeline
        canRedo={commandController.canRedo}
        canUndo={commandController.canUndo}
        onAddAudioTrack={() => addMediaTrack("audio")}
        onAddTextTrack={addTextTrack}
        onAddTitle={addTitle}
        onAddVideoTrack={() => addMediaTrack("video")}
        onDelete={deleteSelected}
        onDeleteTrack={deleteTrack}
        onEdit={(edit, transactionId) => execute(edit, transactionId)}
        onPlayheadChange={(nextPlayheadUs) =>
          editorStore.dispatch(playheadChanged(nextPlayheadUs))
        }
        onRedo={redo}
        onReorderTracks={reorderTracks}
        onSelectClip={(clipId) => editorStore.dispatch(clipSelected(clipId))}
        onSelectTargetAudioTrack={(trackId) =>
          editorStore.dispatch(targetAudioTrackSelected(trackId))
        }
        onSelectTargetTextTrack={(trackId) =>
          editorStore.dispatch(targetTextTrackSelected(trackId))
        }
        onSelectTargetVideoTrack={(trackId) =>
          editorStore.dispatch(targetVideoTrackSelected(trackId))
        }
        onSelectText={(textId) => editorStore.dispatch(textSelected(textId))}
        onTimelineDurationChange={(durationUs) =>
          execute({ durationUs, type: "timeline.duration.set" })
        }
        onSplit={splitSelected}
        onUndo={undo}
        playheadUs={playheadUs}
        project={project}
        selectedClipId={selectedClipId}
        selectedTextId={selectedTextId}
        targetAudioTrackId={targetAudioTrackId}
        targetTextTrackId={targetTextTrackId}
        targetVideoTrackId={targetVideoTrackId}
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
            onClick={() => setStructuredLoggingEnabled((enabled) => !enabled)}
            type="button"
          >
            日志{structuredLoggingEnabled ? "开启" : "关闭"}
          </button>
        </nav>
        <p className="editor__debug-status">
          结构化日志：{structuredLoggingEnabled ? "开启" : "关闭"}
          ；关闭后不再写入总日志、Console 或预览 Worker 日志回传。
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
