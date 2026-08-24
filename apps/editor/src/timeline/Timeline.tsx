import type { ProjectDocument } from "@web-video-editor/domain";
import { useRef } from "react";

import {
  MIN_CLIP_DURATION_US,
  clampClipMove,
  clipDurationUs,
  projectDurationUs,
} from "./timelineMath";
import "./Timeline.css";

type ClipEdit =
  | {
      clipId: string;
      timelineStartUs: number;
      type: "clip.move";
    }
  | {
      clipId: string;
      sourceEndUs: number;
      sourceStartUs: number;
      timelineStartUs: number;
      type: "clip.trim";
    };

export type TimelineProps = {
  canRedo: boolean;
  canUndo: boolean;
  onAddAudioTrack(): void;
  onAddTitle(): void;
  onAddVideoTrack(): void;
  onDelete(): void;
  onEdit(edit: ClipEdit, transactionId: string): void;
  onPlayheadChange(playheadUs: number): void;
  onRedo(): void;
  onSelectClip(clipId: string): void;
  onSelectTargetAudioTrack(trackId: string): void;
  onSelectTargetVideoTrack(trackId: string): void;
  onSelectText(textId: string): void;
  onSplit(): void;
  onUndo(): void;
  playheadUs: number;
  project: ProjectDocument;
  selectedClipId: string | null;
  selectedTextId: string | null;
  targetAudioTrackId: string | null;
  targetVideoTrackId: string | null;
};

type DragState = {
  clipId: string;
  mode: "move" | "trim-end" | "trim-start";
  pointerId: number;
  startClientX: number;
  timelineWidth: number;
  transactionId: string;
  initial: ProjectDocument["clips"][number];
};

function formatTime(timeUs: number): string {
  const totalSeconds = Math.max(0, Math.round(timeUs / 100_000) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
}

export function Timeline({
  canRedo,
  canUndo,
  onAddAudioTrack,
  onAddTitle,
  onAddVideoTrack,
  onDelete,
  onEdit,
  onPlayheadChange,
  onRedo,
  onSelectClip,
  onSelectTargetAudioTrack,
  onSelectTargetVideoTrack,
  onSelectText,
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
  const durationUs = projectDurationUs(project);
  const timelineScaleUs = Math.max(durationUs, 10_000_000);
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

  const beginDrag = (
    event: React.PointerEvent<HTMLDivElement>,
    clip: ProjectDocument["clips"][number],
    mode: DragState["mode"],
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const timeline = event.currentTarget.closest(".timeline__lane");
    if (!(timeline instanceof HTMLElement)) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      clipId: clip.id,
      initial: {
        ...clip,
        effects: clip.effects.map((effect) => ({ ...effect })),
      },
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      timelineWidth: timeline.getBoundingClientRect().width,
      transactionId: `drag-${clip.id}-${crypto.randomUUID()}`,
    };
    selectMediaClip(clip);
  };

  const continueDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const deltaUs =
      ((event.clientX - drag.startClientX) / drag.timelineWidth) *
      timelineScaleUs;
    const clip = drag.initial;
    const asset = assetById.get(clip.assetId);
    if (!asset) {
      return;
    }
    if (drag.mode === "move") {
      onEdit(
        {
          clipId: clip.id,
          timelineStartUs: clampClipMove(
            project,
            clip.id,
            clip.timelineStartUs + deltaUs,
          ),
          type: "clip.move",
        },
        drag.transactionId,
      );
      return;
    }
    if (drag.mode === "trim-start") {
      const maximumDelta =
        clip.sourceEndUs - clip.sourceStartUs - MIN_CLIP_DURATION_US;
      const boundedDelta = Math.max(
        -clip.sourceStartUs,
        Math.min(maximumDelta, Math.round(deltaUs)),
      );
      onEdit(
        {
          clipId: clip.id,
          sourceEndUs: clip.sourceEndUs,
          sourceStartUs: clip.sourceStartUs + boundedDelta,
          timelineStartUs: clampClipMove(
            project,
            clip.id,
            clip.timelineStartUs + boundedDelta,
          ),
          type: "clip.trim",
        },
        drag.transactionId,
      );
      return;
    }
    const nextClip = project.clips
      .filter(
        (candidate) =>
          candidate.trackId === clip.trackId &&
          candidate.timelineStartUs > clip.timelineStartUs,
      )
      .sort((left, right) => left.timelineStartUs - right.timelineStartUs)[0];
    const maximumSourceEnd = Math.min(
      asset.durationUs,
      nextClip
        ? clip.sourceStartUs + nextClip.timelineStartUs - clip.timelineStartUs
        : asset.durationUs,
    );
    onEdit(
      {
        clipId: clip.id,
        sourceEndUs: Math.max(
          clip.sourceStartUs + MIN_CLIP_DURATION_US,
          Math.min(maximumSourceEnd, clip.sourceEndUs + Math.round(deltaUs)),
        ),
        sourceStartUs: clip.sourceStartUs,
        timelineStartUs: clip.timelineStartUs,
        type: "clip.trim",
      },
      drag.transactionId,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = undefined;
    }
  };

  const clipStyle = (startUs: number, endUs: number): React.CSSProperties => ({
    left: `${(startUs / timelineScaleUs) * 100}%`,
    width: `${Math.max(0.7, ((endUs - startUs) / timelineScaleUs) * 100)}%`,
  });

  return (
    <section className="timeline" aria-label="时间线">
      <header className="timeline__toolbar">
        <div>
          <strong>时间线</strong>
          <span>{formatTime(playheadUs)}</span>
        </div>
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

      <div className="timeline__ruler">
        <span>00:00</span>
        <input
          aria-label="时间线播放头"
          max={durationUs}
          min={0}
          onChange={(event) =>
            onPlayheadChange(Number(event.currentTarget.value))
          }
          step={1}
          type="range"
          value={Math.min(playheadUs, durationUs)}
        />
        <span>{formatTime(durationUs)}</span>
      </div>

      <div className="timeline__tracks">
        {orderedTracks.map((track) => {
          if (track.kind === "text") {
            const index = trackIndex(track, textTracks);
            return (
              <div className="timeline__track" key={track.id}>
                <span className="timeline__label">
                  T{index} {track.name}
                </span>
                <div
                  className="timeline__lane"
                  data-testid={testIdForTrack(track)}
                >
                  {orderedTextsForTrack(track.id).map((text) => (
                    <button
                      aria-pressed={selectedTextId === text.id}
                      className="timeline__clip timeline__clip--text"
                      key={text.id}
                      onClick={() => onSelectText(text.id)}
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
          const labelPrefix = isVideo ? "V" : "A";
          const clipKindLabel = isVideo ? "视频" : "音频";

          return (
            <div className="timeline__track" key={track.id}>
              <button
                aria-pressed={targetTrackId === track.id}
                className="timeline__label timeline__label--button"
                onClick={() => onSelectTargetTrack(track.id)}
                type="button"
              >
                {labelPrefix}
                {index} {track.name}
              </button>
              <div
                className="timeline__lane"
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
                            event as unknown as React.PointerEvent<HTMLDivElement>,
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
                            event as unknown as React.PointerEvent<HTMLDivElement>,
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
