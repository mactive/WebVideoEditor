import type {
  Asset,
  Clip,
  Effect,
  ProjectDocument,
  TextItem,
  TextItemInput,
  Track,
} from "./schema";
import { textSchema } from "./schema";
import {
  clipDurationUs,
  MIN_CLIP_DURATION_US,
  projectContentEndUs,
} from "./project";
import { cloneProjectDocument } from "./serialization";
import { ProjectValidationError, validateProjectDocument } from "./validation";

export type AddAssetCommand = {
  type: "asset.add";
  asset: Asset;
  adaptCanvasToAsset?: boolean;
};

export type AddVideoTrackCommand = {
  type: "track.video.add";
  trackId?: string;
};

export type AddAudioTrackCommand = {
  type: "track.audio.add";
  trackId?: string;
};

export type AddTextTrackCommand = {
  type: "track.text.add";
  trackId?: string;
};

export type ReorderTracksCommand = {
  type: "track.reorder";
  trackIds: string[];
};

export type DeleteTrackCommand = {
  type: "track.delete";
  trackId: string;
  cascade?: boolean;
};

export type SetTimelineDurationCommand = {
  type: "timeline.duration.set";
  durationUs: number;
};

export type AddClipCommand = {
  type: "clip.add";
  clip: Clip;
};

export type MoveClipCommand = {
  type: "clip.move";
  clipId: string;
  timelineStartUs: number;
  trackId?: string;
};

export type TrimClipCommand = {
  type: "clip.trim";
  clipId: string;
  timelineStartUs: number;
  sourceStartUs: number;
  sourceEndUs: number;
};

export type TransformClipCommand = {
  type: "clip.transform";
  clipId: string;
  transform: NonNullable<Clip["transform"]>;
};

export type SplitClipCommand = {
  type: "clip.split";
  clipId: string;
  rightClipId: string;
  timelineUs: number;
};

export type DeleteClipCommand = {
  type: "clip.delete";
  clipId: string;
};

export type AddTextCommand = {
  type: "text.add";
  text: TextItemInput;
};

export type DeleteTextCommand = {
  type: "text.delete";
  textId: string;
};

export type UpdateTextCommand = {
  type: "text.update";
  textId: string;
  patch: Partial<
    Pick<
      TextItem,
      | "color"
      | "backgroundColor"
      | "backgroundOpacity"
      | "endUs"
      | "fontFamily"
      | "fontSize"
      | "rotationDeg"
      | "scale"
      | "startUs"
      | "strokeColor"
      | "strokeWidth"
      | "text"
      | "trackId"
      | "x"
      | "y"
    >
  >;
};

export type SetEffectCommand = {
  type: "effect.set";
  clipId: string;
  effectId: string;
  effect: Effect | null;
};

export type ProjectCommand =
  | AddAssetCommand
  | AddAudioTrackCommand
  | AddTextTrackCommand
  | AddVideoTrackCommand
  | AddClipCommand
  | AddTextCommand
  | DeleteClipCommand
  | DeleteTrackCommand
  | DeleteTextCommand
  | MoveClipCommand
  | ReorderTracksCommand
  | SetEffectCommand
  | SetTimelineDurationCommand
  | SplitClipCommand
  | TransformClipCommand
  | TrimClipCommand
  | UpdateTextCommand;

function requiredIndex(
  values: ReadonlyArray<{ id: string }>,
  id: string,
  entity: string,
): number {
  const index = values.findIndex((value) => value.id === id);
  if (index < 0) {
    throw new Error(`${entity} "${id}" 不存在`);
  }
  return index;
}

function nextTrackOrder(tracks: ReadonlyArray<Track>): number {
  return Math.max(-1, ...tracks.map((track) => track.order)) + 1;
}

function kindLabel(kind: Track["kind"]): string {
  switch (kind) {
    case "audio":
      return "音频";
    case "text":
      return "文字";
    case "video":
      return "视频";
  }
}

function normalizeTrackOrder(
  project: ProjectDocument,
  trackIds?: readonly string[],
): void {
  const orderedTracks = trackIds
    ? trackIds.map((trackId) => {
        const index = requiredIndex(project.tracks, trackId, "轨道");
        return project.tracks[index]!;
      })
    : [...project.tracks].sort(
        (left, right) =>
          left.order - right.order || left.id.localeCompare(right.id),
      );

  if (trackIds) {
    const uniqueTrackIds = new Set(trackIds);
    if (
      trackIds.length !== project.tracks.length ||
      uniqueTrackIds.size !== project.tracks.length
    ) {
      throw new Error("轨道重排必须包含所有轨道且不能重复");
    }
  }

  orderedTracks.forEach((track, index) => {
    track.order = index;
  });
}

function ensureTimelineDurationCoversContent(project: ProjectDocument): void {
  project.timeline.durationUs = Math.max(
    project.timeline.durationUs,
    projectContentEndUs(project),
  );
}

function createTrack(
  project: ProjectDocument,
  kind: Track["kind"],
  trackId?: string,
): Track {
  const trackIndex =
    project.tracks.filter((track) => track.kind === kind).length + 1;
  const label = kindLabel(kind);
  let id =
    trackId ??
    (trackIndex === 1 ? `${kind}-track` : `${kind}-track-${trackIndex}`);
  let suffix = trackIndex;

  while (!trackId && project.tracks.some((track) => track.id === id)) {
    suffix += 1;
    id = `${kind}-track-${suffix}`;
  }

  return {
    id,
    kind,
    name: trackIndex === 1 ? label : `${label} ${trackIndex}`,
    order: nextTrackOrder(project.tracks),
    muted: false,
    locked: false,
  };
}

function cloneClipEffects(effects: readonly Effect[]): Effect[] {
  return effects.map((effect) => ({ ...effect }));
}

function cloneClipTransform(transform: Clip["transform"]): Clip["transform"] {
  return transform ? { ...transform } : undefined;
}

function applyUnchecked(
  project: ProjectDocument,
  command: ProjectCommand,
): void {
  switch (command.type) {
    case "asset.add": {
      if (project.assets.some((asset) => asset.id === command.asset.id)) {
        throw new Error(`素材 "${command.asset.id}" 已存在`);
      }
      if (command.adaptCanvasToAsset && project.assets.length === 0) {
        project.canvas.width = command.asset.width;
        project.canvas.height = command.asset.height;
      }
      project.assets.push(command.asset);
      break;
    }
    case "track.audio.add":
    case "track.text.add":
    case "track.video.add": {
      if (
        command.trackId &&
        project.tracks.some((track) => track.id === command.trackId)
      ) {
        throw new Error(`轨道 "${command.trackId}" 已存在`);
      }
      project.tracks.push(
        createTrack(
          project,
          command.type === "track.video.add"
            ? "video"
            : command.type === "track.audio.add"
              ? "audio"
              : "text",
          command.trackId,
        ),
      );
      break;
    }
    case "track.reorder": {
      normalizeTrackOrder(project, command.trackIds);
      break;
    }
    case "track.delete": {
      const index = requiredIndex(project.tracks, command.trackId, "轨道");
      const track = project.tracks[index];
      if (!track) {
        break;
      }
      const sameKindTracks = project.tracks.filter(
        (candidate) => candidate.kind === track.kind,
      );
      if (sameKindTracks.length <= 1) {
        throw new Error(`不能删除最后一条${kindLabel(track.kind)}轨道`);
      }

      const hasClips = project.clips.some(
        (clip) => clip.trackId === command.trackId,
      );
      const hasTexts = project.texts.some(
        (text) => text.trackId === command.trackId,
      );
      if ((hasClips || hasTexts) && !command.cascade) {
        throw new Error("轨道包含内容，删除前必须确认级联删除");
      }

      if (command.cascade) {
        project.clips = project.clips.filter(
          (clip) => clip.trackId !== command.trackId,
        );
        project.texts = project.texts.filter(
          (text) => text.trackId !== command.trackId,
        );
      }
      project.tracks.splice(index, 1);
      normalizeTrackOrder(project);
      break;
    }
    case "timeline.duration.set": {
      project.timeline.durationUs = Math.max(
        command.durationUs,
        projectContentEndUs(project),
      );
      break;
    }
    case "clip.add": {
      if (project.clips.some((clip) => clip.id === command.clip.id)) {
        throw new Error(`片段 "${command.clip.id}" 已存在`);
      }
      project.clips.push(command.clip);
      break;
    }
    case "clip.move": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      const clip = project.clips[index];
      if (clip) {
        if (command.trackId && command.trackId !== clip.trackId) {
          const sourceTrack =
            project.tracks[requiredIndex(project.tracks, clip.trackId, "轨道")];
          const targetTrack =
            project.tracks[
              requiredIndex(project.tracks, command.trackId, "轨道")
            ];
          if (
            !sourceTrack ||
            !targetTrack ||
            sourceTrack.kind !== targetTrack.kind ||
            targetTrack.kind === "text"
          ) {
            throw new Error("片段只能移动到同类型媒体轨道");
          }
          clip.trackId = command.trackId;
        }
        clip.timelineStartUs = command.timelineStartUs;
      }
      break;
    }
    case "clip.trim": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      const clip = project.clips[index];
      if (clip) {
        clip.timelineStartUs = command.timelineStartUs;
        clip.sourceStartUs = command.sourceStartUs;
        clip.sourceEndUs = command.sourceEndUs;
      }
      break;
    }
    case "clip.transform": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      const clip = project.clips[index];
      if (clip) {
        clip.transform = command.transform;
      }
      break;
    }
    case "clip.split": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      if (project.clips.some((clip) => clip.id === command.rightClipId)) {
        throw new Error(`片段 "${command.rightClipId}" 已存在`);
      }
      const clip = project.clips[index];
      if (!clip) {
        break;
      }
      const offsetUs = command.timelineUs - clip.timelineStartUs;
      const durationUs = clipDurationUs(clip);
      if (offsetUs <= 0 || offsetUs >= durationUs) {
        throw new Error("分割时间必须位于片段内部");
      }
      const originalSourceEndUs = clip.sourceEndUs;
      const splitSourceUs = clip.sourceStartUs + offsetUs;
      const leftDurationUs = splitSourceUs - clip.sourceStartUs;
      const rightDurationUs = originalSourceEndUs - splitSourceUs;
      if (
        leftDurationUs < MIN_CLIP_DURATION_US ||
        rightDurationUs < MIN_CLIP_DURATION_US
      ) {
        throw new Error(
          `分割后的片段时长不能短于 ${MIN_CLIP_DURATION_US} 微秒`,
        );
      }
      clip.sourceEndUs = splitSourceUs;
      project.clips.splice(index + 1, 0, {
        ...clip,
        id: command.rightClipId,
        timelineStartUs: command.timelineUs,
        sourceStartUs: splitSourceUs,
        sourceEndUs: originalSourceEndUs,
        effects: cloneClipEffects(clip.effects),
        ...(clip.transform
          ? { transform: cloneClipTransform(clip.transform) }
          : {}),
      });
      break;
    }
    case "clip.delete": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      project.clips.splice(index, 1);
      break;
    }
    case "text.add": {
      if (project.texts.some((text) => text.id === command.text.id)) {
        throw new Error(`文字 "${command.text.id}" 已存在`);
      }
      project.texts.push(textSchema.parse(command.text));
      break;
    }
    case "text.delete": {
      const index = requiredIndex(project.texts, command.textId, "文字");
      project.texts.splice(index, 1);
      break;
    }
    case "text.update": {
      const index = requiredIndex(project.texts, command.textId, "文字");
      const text = project.texts[index];
      if (text) {
        Object.assign(text, command.patch);
      }
      break;
    }
    case "effect.set": {
      const index = requiredIndex(project.clips, command.clipId, "片段");
      const clip = project.clips[index];
      if (!clip) {
        break;
      }
      const effectIndex = clip.effects.findIndex(
        (effect) => effect.id === command.effectId,
      );
      if (command.effect === null) {
        if (effectIndex >= 0) {
          clip.effects.splice(effectIndex, 1);
        }
      } else {
        if (command.effect.id !== command.effectId) {
          throw new Error("effect.id 必须与 effectId 一致");
        }
        if (effectIndex >= 0) {
          clip.effects[effectIndex] = command.effect;
        } else {
          clip.effects.push(command.effect);
        }
      }
      break;
    }
  }
}

export function applyProjectCommand(
  current: ProjectDocument,
  command: ProjectCommand,
  now = new Date().toISOString(),
): ProjectDocument {
  const before = validateProjectDocument(current);
  if (!before.success) {
    throw new ProjectValidationError(before.issues);
  }

  const next = cloneProjectDocument(current);
  applyUnchecked(next, command);
  ensureTimelineDurationCoversContent(next);
  next.revision += 1;
  next.updatedAt = now;

  const after = validateProjectDocument(next);
  if (!after.success) {
    throw new ProjectValidationError(after.issues);
  }
  return after.data;
}
