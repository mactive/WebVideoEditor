import type { Asset, Clip, Effect, ProjectDocument, TextItem } from "./schema";
import { cloneProjectDocument } from "./serialization";
import { ProjectValidationError, validateProjectDocument } from "./validation";

export type AddAssetCommand = {
  type: "asset.add";
  asset: Asset;
  adaptCanvasToAsset?: boolean;
};

export type AddClipCommand = {
  type: "clip.add";
  clip: Clip;
};

export type MoveClipCommand = {
  type: "clip.move";
  clipId: string;
  timelineStartUs: number;
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
  text: TextItem;
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
      | "endUs"
      | "fontSize"
      | "rotationDeg"
      | "scale"
      | "startUs"
      | "text"
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
  | AddClipCommand
  | AddTextCommand
  | DeleteClipCommand
  | DeleteTextCommand
  | MoveClipCommand
  | SetEffectCommand
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
      const durationUs = clip.sourceEndUs - clip.sourceStartUs;
      if (offsetUs <= 0 || offsetUs >= durationUs) {
        throw new Error("分割时间必须位于片段内部");
      }
      const originalSourceEndUs = clip.sourceEndUs;
      const splitSourceUs = clip.sourceStartUs + offsetUs;
      clip.sourceEndUs = splitSourceUs;
      project.clips.splice(index + 1, 0, {
        ...clip,
        id: command.rightClipId,
        timelineStartUs: command.timelineUs,
        sourceStartUs: splitSourceUs,
        sourceEndUs: originalSourceEndUs,
        effects: clip.effects.map((effect) => ({ ...effect })),
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
      project.texts.push(command.text);
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
  next.revision += 1;
  next.updatedAt = now;

  const after = validateProjectDocument(next);
  if (!after.success) {
    throw new ProjectValidationError(after.issues);
  }
  return after.data;
}
