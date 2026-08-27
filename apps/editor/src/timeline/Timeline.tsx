import {
  projectContentEndUs,
  type ProjectCommand,
  type ProjectDocument,
} from "@web-video-editor/domain";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  MIN_CLIP_DURATION_US,
  clampClipSourceEnd,
  clampClipTrimStart,
  clampClipMove,
  clampTextMove,
  clipDurationUs,
  type ClipTrimLimit,
  type ClipTrimResult,
  pixelsToTimeUs,
  projectDurationUs,
  timeUsToPixels,
} from "./timelineMath";
import "./Timeline.css";

type TimelineEdit = Extract<
  ProjectCommand,
  { type: "clip.move" | "clip.trim" | "text.update" }
>;

export type TimelineProps = {
  canRedo: boolean;
  canUndo: boolean;
  onAddAudioTrack(): void;
  onAddTitle(): void;
  onAddVideoTrack(): void;
  onDelete(): void;
  onDeleteTrack(trackId: string, cascade: boolean): void;
  onEdit(edit: TimelineEdit, transactionId: string): void;
  onPlayheadChange(playheadUs: number): void;
  onRedo(): void;
  onReorderTracks(trackIds: string[]): void;
  onSelectClip(clipId: string): void;
  onSelectTargetAudioTrack(trackId: string): void;
  onSelectTargetVideoTrack(trackId: string): void;
  onSelectText(textId: string): void;
  onTimelineDurationChange(durationUs: number): void;
  onSplit(): void;
  onUndo(): void;
  playheadUs: number;
  project: ProjectDocument;
  selectedClipId: string | null;
  selectedTextId: string | null;
  targetAudioTrackId: string | null;
  targetVideoTrackId: string | null;
};

type ClipDragState = {
  clipId: string;
  initial: ProjectDocument["clips"][number];
  item: "clip";
  mode: "move" | "trim-end" | "trim-start";
  pixelsPerSecond: number;
  pointerId: number;
  startClientX: number;
  transactionId: string;
};

type TextDragState = {
  initial: ProjectDocument["texts"][number];
  item: "text";
  mode: "move";
  pixelsPerSecond: number;
  pointerId: number;
  startClientX: number;
  transactionId: string;
};

type DragState = ClipDragState | TextDragState;

type TrackDragState = {
  trackId: string;
};

const TIMELINE_DURATION_PRESETS_US = [
  { label: "1min", value: 60_000_000 },
  { label: "3min", value: 180_000_000 },
  { label: "5min", value: 300_000_000 },
  { label: "10min", value: 600_000_000 },
] as const;

const MIN_TIMELINE_PIXELS_PER_SECOND = 20;
const MAX_TIMELINE_PIXELS_PER_SECOND = 240;

function clampPixelsPerSecond(pixelsPerSecond: number): number {
  return Math.max(
    MIN_TIMELINE_PIXELS_PER_SECOND,
    Math.min(MAX_TIMELINE_PIXELS_PER_SECOND, pixelsPerSecond),
  );
}

function formatTime(timeUs: number): string {
  const totalSeconds = Math.max(0, Math.round(timeUs / 100_000) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

function durationInputValue(durationUs: number): string {
  return String(Math.round(durationUs / 1_000) / 1_000);
}

function trimLimitNotice(limit: ClipTrimLimit): string | undefined {
  switch (limit) {
    case "minimum-duration":
      return `片段已达到最小时长 ${durationInputValue(MIN_CLIP_DURATION_US)} 秒。`;
    case "source-boundary":
      return "裁剪已受素材边界限制。";
    case "timeline-boundary":
      return "裁剪已受时间线起点限制。";
    case "track-conflict":
      return "裁剪已受同轨相邻片段限制，不能产生重叠。";
    case "none":
      return undefined;
  }
}

function clipTrimChanged(
  clip: ProjectDocument["clips"][number],
  trim: ClipTrimResult,
): boolean {
  return (
    clip.timelineStartUs !== trim.timelineStartUs ||
    clip.sourceStartUs !== trim.sourceStartUs ||
    clip.sourceEndUs !== trim.sourceEndUs
  );
}

export function Timeline({
  canRedo,
  canUndo,
  onAddAudioTrack,
  onAddTitle,
  onAddVideoTrack,
  onDelete,
  onDeleteTrack,
  onEdit,
  onPlayheadChange,
  onRedo,
  onReorderTracks,
  onSelectClip,
  onSelectTargetAudioTrack,
  onSelectTargetVideoTrack,
  onSelectText,
  onTimelineDurationChange,
  onSplit,
  onUndo,
  playheadUs,
  project,
  selectedClipId,
  selectedTextId,
  targetAudioTrackId,
  targetVideoTrackId,
}: TimelineProps) {
  const dragRef = useRef<DragState | undefined>(undefined);
  const trackDragRef = useRef<TrackDragState | undefined>(undefined);
  const durationUs = projectDurationUs(project);
  const contentEndUs = projectContentEndUs(project);
  const [dragNotice, setDragNotice] = useState<string | undefined>();
  const [durationInputSeconds, setDurationInputSeconds] = useState(() =>
    durationInputValue(durationUs),
  );
  const [durationNotice, setDurationNotice] = useState<string | undefined>();
  const [pixelsPerSecond, setPixelsPerSecond] = useState(() =>
    clampPixelsPerSecond(project.timeline.defaultScale.pixelsPerSecond),
  );
  useEffect(() => {
    setDurationInputSeconds(durationInputValue(durationUs));
  }, [durationUs]);
  const timelineWidthPx = Math.max(
    1,
    timeUsToPixels(durationUs, pixelsPerSecond),
  );
  const timelineStyle = {
    "--timeline-content-width": `${Math.ceil(timelineWidthPx)}px`,
  } as CSSProperties;
  const assetById = new Map(project.assets.map((asset) => [asset.id, asset]));
  const orderedTracks = [...project.tracks].sort(
    (left, right) => left.order - right.order,
  );
  const trackById = new Map(project.tracks.map((track) => [track.id, track]));
  const videoTracks = orderedTracks.filter((track) => track.kind === "video");
  const audioTracks = orderedTracks.filter((track) => track.kind === "audio");
  const textTracks = orderedTracks.filter((track) => track.kind === "text");
  const clipsByTrack = new Map<string, ProjectDocument["clips"]>();
  for (const clip of project.clips) {
    const clips = clipsByTrack.get(clip.trackId) ?? [];
    clips.push(clip);
    clipsByTrack.set(clip.trackId, clips);
  }
  const textsByTrack = new Map<string, ProjectDocument["texts"]>();
  for (const text of project.texts) {
    const texts = textsByTrack.get(text.trackId) ?? [];
    texts.push(text);
    textsByTrack.set(text.trackId, texts);
  }
  const selectMediaClip = (clip: ProjectDocument["clips"][number]) => {
    const track = trackById.get(clip.trackId);
    if (track?.kind === "audio") {
      onSelectTargetAudioTrack(clip.trackId);
    } else if (track?.kind === "video") {
      onSelectTargetVideoTrack(clip.trackId);
    }
    onSelectClip(clip.id);
  };
  const trackIndex = (
    track: ProjectDocument["tracks"][number],
    tracks: ProjectDocument["tracks"],
  ) => tracks.findIndex((candidate) => candidate.id === track.id) + 1;
  const testIdForTrack = (track: ProjectDocument["tracks"][number]) =>
    track.kind === "video"
      ? `video-track-${track.id}`
      : track.id === `${track.kind}-track`
        ? track.id
        : `${track.kind}-track-${track.id}`;
  const orderedClipsForTrack = (trackId: string) =>
    [...(clipsByTrack.get(trackId) ?? [])].sort(
      (left, right) => left.timelineStartUs - right.timelineStartUs,
    );
  const orderedTextsForTrack = (trackId: string) =>
    [...(textsByTrack.get(trackId) ?? [])].sort(
      (left, right) => left.startUs - right.startUs,
    );
  const trackAtPointer = (clientY: number) => {
    if (!Number.isFinite(clientY)) {
      return undefined;
    }
    const lanes = document.querySelectorAll<HTMLElement>(
      ".timeline__lane[data-track-id]",
    );
    for (const lane of lanes) {
      const rect = lane.getBoundingClientRect();
      if (clientY >= rect.top && clientY <= rect.bottom) {
        return trackById.get(lane.dataset.trackId ?? "");
      }
    }
    return undefined;
  };
  const updateDragNotice = (notice: string | undefined) => {
    setDragNotice((current) => (current === notice ? current : notice));
  };
  const trackKindLabel = (kind: ProjectDocument["tracks"][number]["kind"]) =>
    kind === "video" ? "视频" : kind === "audio" ? "音频" : "文字";
  const trackLabel = (
    track: ProjectDocument["tracks"][number],
    index: number,
  ) => {
    const prefix =
      track.kind === "video" ? "V" : track.kind === "audio" ? "A" : "T";
    return `${prefix}${index} ${track.name}`;
  };
  const reorderedTrackIds = (sourceTrackId: string, targetTrackId: string) => {
    const nextTrackIds = orderedTracks.map((track) => track.id);
    const sourceIndex = nextTrackIds.indexOf(sourceTrackId);
    const targetIndex = nextTrackIds.indexOf(targetTrackId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      return nextTrackIds;
    }
    const [movedTrackId] = nextTrackIds.splice(sourceIndex, 1);
    if (!movedTrackId) {
      return nextTrackIds;
    }
    nextTrackIds.splice(targetIndex, 0, movedTrackId);
    return nextTrackIds;
  };
  const beginTrackDrag = (
    event: DragEvent<HTMLDivElement>,
    track: ProjectDocument["tracks"][number],
  ) => {
    trackDragRef.current = { trackId: track.id };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", track.id);
  };
  const dragOverTrack = (
    event: DragEvent<HTMLDivElement>,
    track: ProjectDocument["tracks"][number],
  ) => {
    const sourceTrackId = trackDragRef.current?.trackId;
    if (sourceTrackId && sourceTrackId !== track.id) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }
  };
  const dropTrack = (
    event: DragEvent<HTMLDivElement>,
    track: ProjectDocument["tracks"][number],
  ) => {
    event.preventDefault();
    const sourceTrackId =
      trackDragRef.current?.trackId || event.dataTransfer.getData("text/plain");
    trackDragRef.current = undefined;
    if (!sourceTrackId || sourceTrackId === track.id) {
      return;
    }
    const nextTrackIds = reorderedTrackIds(sourceTrackId, track.id);
    if (
      nextTrackIds.join("\0") !==
      orderedTracks.map((item) => item.id).join("\0")
    ) {
      onReorderTracks(nextTrackIds);
    }
  };
  const deleteTrack = (track: ProjectDocument["tracks"][number]) => {
    const sameKindTrackCount = project.tracks.filter(
      (candidate) => candidate.kind === track.kind,
    ).length;
    if (sameKindTrackCount <= 1) {
      onDeleteTrack(track.id, false);
      return;
    }
    const contentCount =
      (clipsByTrack.get(track.id)?.length ?? 0) +
      (textsByTrack.get(track.id)?.length ?? 0);
    if (
      contentCount > 0 &&
      !window.confirm(
        `轨道 "${track.name}" 包含 ${contentCount} 个内容，删除后会一并移除。确认删除？`,
      )
    ) {
      return;
    }
    onDeleteTrack(track.id, contentCount > 0);
  };
  const renderTrackHeader = (
    track: ProjectDocument["tracks"][number],
    label: string,
    content: ReactNode,
  ) => (
    <div
      aria-label={`轨道头 ${label}`}
      className="timeline__track-header"
      draggable
      onDragEnd={() => {
        trackDragRef.current = undefined;
      }}
      onDragOver={(event) => dragOverTrack(event, track)}
      onDragStart={(event) => beginTrackDrag(event, track)}
      onDrop={(event) => dropTrack(event, track)}
    >
      {content}
      <button
        aria-label={`删除轨道 ${label}`}
        className="timeline__track-delete"
        onClick={() => deleteTrack(track)}
        type="button"
      >
        删除
      </button>
    </div>
  );
  const requestTimelineDuration = (requestedDurationUs: number) => {
    const roundedDurationUs = Math.max(0, Math.round(requestedDurationUs));
    onTimelineDurationChange(roundedDurationUs);
    if (roundedDurationUs < contentEndUs) {
      setDurationNotice(
        `内容末尾为 ${formatTime(contentEndUs)}，实际总长已保留到内容末尾。`,
      );
      return;
    }
    setDurationNotice(`时间线总长已设置为 ${formatTime(roundedDurationUs)}。`);
  };
  const applyDurationInput = () => {
    const seconds = Number(durationInputSeconds);
    if (!Number.isFinite(seconds) || seconds < 0) {
      setDurationNotice("请输入非负秒数。");
      return;
    }
    requestTimelineDuration(seconds * 1_000_000);
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    clip: ProjectDocument["clips"][number],
    mode: DragState["mode"],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      clipId: clip.id,
      initial: {
        ...clip,
        effects: clip.effects.map((effect) => ({ ...effect })),
      },
      item: "clip",
      mode,
      pixelsPerSecond,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      transactionId: `drag-${clip.id}-${crypto.randomUUID()}`,
    };
    selectMediaClip(clip);
  };

  const beginTextDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    text: ProjectDocument["texts"][number],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      initial: { ...text },
      item: "text",
      mode: "move",
      pixelsPerSecond,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      transactionId: `drag-${text.id}-${crypto.randomUUID()}`,
    };
    onSelectText(text.id);
  };

  const continueDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaUs = pixelsToTimeUs(
      event.clientX - drag.startClientX,
      drag.pixelsPerSecond,
    );
    if (drag.item === "text") {
      const text = drag.initial;
      const sourceTrack = trackById.get(text.trackId);
      const targetTrack = trackAtPointer(event.clientY) ?? sourceTrack;
      if (!targetTrack || targetTrack.kind !== "text") {
        updateDragNotice("文字片段只能移动到文字轨。");
        return;
      }
      const proposedStartUs = text.startUs + deltaUs;
      const timelineStartUs = clampTextMove(
        project,
        text.id,
        proposedStartUs,
        targetTrack.id,
      );
      const textDurationUs = text.endUs - text.startUs;
      updateDragNotice(
        timelineStartUs === Math.max(0, Math.round(proposedStartUs))
          ? undefined
          : `目标文字轨存在时间冲突，已夹紧到 ${formatTime(timelineStartUs)}。`,
      );
      onEdit(
        {
          patch: {
            endUs: timelineStartUs + textDurationUs,
            startUs: timelineStartUs,
            trackId: targetTrack.id,
          },
          textId: text.id,
          type: "text.update",
        },
        drag.transactionId,
      );
      return;
    }
    const clip = drag.initial;
    const asset = assetById.get(clip.assetId);
    if (!asset) {
      return;
    }
    if (drag.mode === "move") {
      const sourceTrack = trackById.get(clip.trackId);
      const targetTrack = trackAtPointer(event.clientY) ?? sourceTrack;
      if (
        !sourceTrack ||
        !targetTrack ||
        targetTrack.kind !== sourceTrack.kind ||
        targetTrack.kind === "text"
      ) {
        updateDragNotice(
          sourceTrack && targetTrack
            ? `不能将${trackKindLabel(sourceTrack.kind)}片段移动到${trackKindLabel(targetTrack.kind)}轨。`
            : "未命中可移动的目标轨道。",
        );
        return;
      }
      const proposedStartUs = clip.timelineStartUs + deltaUs;
      const timelineStartUs = clampClipMove(
        project,
        clip.id,
        proposedStartUs,
        targetTrack.id,
      );
      updateDragNotice(
        timelineStartUs === Math.max(0, Math.round(proposedStartUs))
          ? undefined
          : `目标轨道存在时间冲突，已夹紧到 ${formatTime(timelineStartUs)}。`,
      );
      onEdit(
        {
          clipId: clip.id,
          timelineStartUs,
          trackId: targetTrack.id,
          type: "clip.move",
        },
        drag.transactionId,
      );
      return;
    }
    if (drag.mode === "trim-start") {
      const trim = clampClipTrimStart(project, clip, deltaUs);
      updateDragNotice(trimLimitNotice(trim.limit));
      const currentClip =
        project.clips.find((candidate) => candidate.id === clip.id) ?? clip;
      if (!clipTrimChanged(currentClip, trim)) {
        return;
      }
      onEdit(
        {
          clipId: clip.id,
          sourceEndUs: trim.sourceEndUs,
          sourceStartUs: trim.sourceStartUs,
          timelineStartUs: trim.timelineStartUs,
          type: "clip.trim",
        },
        drag.transactionId,
      );
      return;
    }
    const trim = clampClipSourceEnd(
      project,
      clip,
      asset.durationUs,
      clip.sourceEndUs + deltaUs,
    );
    updateDragNotice(trimLimitNotice(trim.limit));
    const currentClip =
      project.clips.find((candidate) => candidate.id === clip.id) ?? clip;
    if (!clipTrimChanged(currentClip, trim)) {
      return;
    }
    onEdit(
      {
        clipId: clip.id,
        sourceEndUs: trim.sourceEndUs,
        sourceStartUs: trim.sourceStartUs,
        timelineStartUs: trim.timelineStartUs,
        type: "clip.trim",
      },
      drag.transactionId,
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
      setDragNotice(undefined);
    }
  };

  const clipStyle = (startUs: number, endUs: number): CSSProperties => ({
    left: `${timeUsToPixels(startUs, pixelsPerSecond)}px`,
    width: `${Math.max(8, timeUsToPixels(endUs - startUs, pixelsPerSecond))}px`,
  });

  return (
    <section className="timeline" aria-label="时间线" style={timelineStyle}>
      <header className="timeline__toolbar">
        <div>
          <strong>时间线</strong>
          <span>{formatTime(playheadUs)}</span>
        </div>
        <div className="timeline__duration-controls" aria-label="时间线总时长">
          {TIMELINE_DURATION_PRESETS_US.map((preset) => (
            <button
              key={preset.label}
              onClick={() => requestTimelineDuration(preset.value)}
              type="button"
            >
              {preset.label}
            </button>
          ))}
          <label>
            <span>总长秒</span>
            <input
              aria-label="时间线总时长（秒）"
              min={0}
              onChange={(event) =>
                setDurationInputSeconds(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  applyDurationInput();
                }
              }}
              step={0.001}
              type="number"
              value={durationInputSeconds}
            />
          </label>
          <button onClick={applyDurationInput} type="button">
            应用总长
          </button>
        </div>
        <label className="timeline__zoom">
          <span>缩放</span>
          <input
            aria-label="时间线缩放"
            max={MAX_TIMELINE_PIXELS_PER_SECOND}
            min={MIN_TIMELINE_PIXELS_PER_SECOND}
            onChange={(event) =>
              setPixelsPerSecond(
                clampPixelsPerSecond(Number(event.currentTarget.value)),
              )
            }
            step={10}
            type="range"
            value={pixelsPerSecond}
          />
          <span>{pixelsPerSecond}px/s</span>
        </label>
        <button onClick={onAddTitle} type="button">
          添加标题
        </button>
        <button onClick={onAddVideoTrack} type="button">
          新增视频轨
        </button>
        <button onClick={onAddAudioTrack} type="button">
          新增音频轨
        </button>
        <button disabled={!selectedClipId} onClick={onSplit} type="button">
          播放头分割
        </button>
        <button
          disabled={!selectedClipId && !selectedTextId}
          onClick={onDelete}
          type="button"
        >
          删除
        </button>
        <button disabled={!canUndo} onClick={onUndo} type="button">
          Undo
        </button>
        <button disabled={!canRedo} onClick={onRedo} type="button">
          Redo
        </button>
      </header>
      {dragNotice || durationNotice ? (
        <p className="timeline__notice" role="status">
          {dragNotice ?? durationNotice}
        </p>
      ) : null}

      <div className="timeline__ruler">
        <span>00:00</span>
        <div className="timeline__ruler-scroll">
          <input
            aria-label="时间线播放头"
            max={durationUs}
            min={0}
            onChange={(event) =>
              onPlayheadChange(Number(event.currentTarget.value))
            }
            step={1}
            style={{ width: `${timelineWidthPx}px` }}
            type="range"
            value={Math.min(playheadUs, durationUs)}
          />
        </div>
        <span>{formatTime(durationUs)}</span>
      </div>

      <div className="timeline__tracks">
        {orderedTracks.map((track) => {
          if (track.kind === "text") {
            const index = trackIndex(track, textTracks);
            const label = trackLabel(track, index);
            return (
              <div className="timeline__track" key={track.id}>
                {renderTrackHeader(
                  track,
                  label,
                  <span className="timeline__label">{label}</span>,
                )}
                <div
                  className="timeline__lane"
                  data-track-id={track.id}
                  data-testid={testIdForTrack(track)}
                >
                  {orderedTextsForTrack(track.id).map((text) => (
                    <button
                      aria-pressed={selectedTextId === text.id}
                      className="timeline__clip timeline__clip--text"
                      key={text.id}
                      onClick={() => onSelectText(text.id)}
                      onPointerDown={(event) => beginTextDrag(event, text)}
                      onPointerMove={
                        continueDrag as unknown as (
                          event: ReactPointerEvent<HTMLButtonElement>,
                        ) => void
                      }
                      onPointerUp={
                        endDrag as unknown as (
                          event: ReactPointerEvent<HTMLButtonElement>,
                        ) => void
                      }
                      style={clipStyle(text.startUs, text.endUs)}
                      type="button"
                    >
                      {text.text || "空标题"}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          const isVideo = track.kind === "video";
          const index = trackIndex(track, isVideo ? videoTracks : audioTracks);
          const targetTrackId = isVideo
            ? targetVideoTrackId
            : targetAudioTrackId;
          const onSelectTargetTrack = isVideo
            ? onSelectTargetVideoTrack
            : onSelectTargetAudioTrack;
          const label = trackLabel(track, index);
          const clipKindLabel = isVideo ? "视频" : "音频";

          return (
            <div className="timeline__track" key={track.id}>
              {renderTrackHeader(
                track,
                label,
                <button
                  aria-pressed={targetTrackId === track.id}
                  className="timeline__label timeline__label--button"
                  onClick={() => onSelectTargetTrack(track.id)}
                  type="button"
                >
                  {label}
                </button>,
              )}
              <div
                className="timeline__lane"
                data-track-id={track.id}
                data-testid={testIdForTrack(track)}
              >
                {orderedClipsForTrack(track.id).map((clip) => {
                  const asset = assetById.get(clip.assetId);
                  return (
                    <div
                      aria-label={`${clipKindLabel}片段 ${asset?.name ?? clip.id}`}
                      aria-selected={selectedClipId === clip.id}
                      className={`timeline__clip timeline__clip--${track.kind}`}
                      data-clip-id={clip.id}
                      key={clip.id}
                      onClick={() => selectMediaClip(clip)}
                      onPointerDown={(event) => beginDrag(event, clip, "move")}
                      onPointerMove={continueDrag}
                      onPointerUp={endDrag}
                      role="button"
                      style={clipStyle(
                        clip.timelineStartUs,
                        clip.timelineStartUs + clipDurationUs(clip),
                      )}
                      tabIndex={0}
                    >
                      <button
                        aria-label={`裁剪 ${clipKindLabel} ${asset?.name ?? clip.id} 开头`}
                        className="timeline__trim timeline__trim--start"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          beginDrag(
                            event as unknown as ReactPointerEvent<HTMLDivElement>,
                            clip,
                            "trim-start",
                          );
                        }}
                        type="button"
                      />
                      <span>
                        {isVideo ? "▣" : "▥"} {asset?.name ?? clip.id}
                      </span>
                      <button
                        aria-label={`裁剪 ${clipKindLabel} ${asset?.name ?? clip.id} 结尾`}
                        className="timeline__trim timeline__trim--end"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          beginDrag(
                            event as unknown as ReactPointerEvent<HTMLDivElement>,
                            clip,
                            "trim-end",
                          );
                        }}
                        type="button"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
