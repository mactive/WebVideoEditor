import type { Effect, ProjectDocument } from "@web-video-editor/domain";

import type { NormalizedEffect, QualityProfile } from "./types";

function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { height: number; width: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    height: Math.max(2, Math.round(height * scale)),
    width: Math.max(2, Math.round(width * scale)),
  };
}

export function resolveQualityProfile(
  project: Pick<ProjectDocument, "canvas" | "exportSettings">,
  kind: QualityProfile["kind"],
): QualityProfile {
  if (kind === "export") {
    return {
      frameRate: project.exportSettings.frameRate,
      height: project.exportSettings.height,
      kind,
      mediaSource: "original",
      width: project.exportSettings.width,
    };
  }
  const size = fitWithin(project.canvas.width, project.canvas.height, 960, 540);
  return {
    frameRate: Math.min(project.exportSettings.frameRate, 30),
    height: size.height,
    kind,
    mediaSource: "proxy",
    width: size.width,
  };
}

export function resolveEffects(
  effects: readonly Effect[],
): readonly NormalizedEffect[] {
  const resolved: NormalizedEffect[] = [];
  for (const effect of effects) {
    if (!effect.enabled) {
      continue;
    }
    switch (effect.kind) {
      case "grayscale":
      case "vintage":
        resolved.push({
          amount: Math.max(0, Math.min(1, effect.amount)),
          id: effect.id,
          kind: effect.kind,
        });
        break;
      case "adjustments":
        resolved.push({
          brightness: Math.max(-1, Math.min(1, effect.brightness)),
          contrast: Math.max(-1, Math.min(1, effect.contrast)),
          id: effect.id,
          kind: effect.kind,
        });
        break;
    }
  }
  return resolved;
}
