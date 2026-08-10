import { resolveEffects } from "./quality";
import type { QualityProfile, RuntimeEntity } from "./types";

export const PREVIEW_SYSTEM_ORDER = [
  "timeline",
  "animation",
  "transform",
  "video",
  "effect",
  "render",
] as const;

export type PreviewSystemName = (typeof PREVIEW_SYSTEM_ORDER)[number];

export type RuntimeRenderTarget = {
  sync(entities: readonly RuntimeEntity[]): void;
};

export type SystemContext = {
  entities: Iterable<RuntimeEntity>;
  playheadUs: number;
  profile: QualityProfile;
  renderTarget?: RuntimeRenderTarget;
};

export type PreviewSystem = {
  name: PreviewSystemName;
  run(context: SystemContext): void;
};

export const timelineSystem: PreviewSystem = {
  name: "timeline",
  run({ entities, playheadUs }) {
    for (const entity of entities) {
      entity.timeline.active =
        playheadUs >= entity.timeline.startUs &&
        playheadUs < entity.timeline.endUs;
      entity.timeline.localTimeUs = Math.max(
        0,
        playheadUs - entity.timeline.startUs,
      );
    }
  },
};

export const animationSystem: PreviewSystem = {
  name: "animation",
  run({ entities }) {
    for (const entity of entities) {
      entity.animation.opacity = entity.timeline.active ? 1 : 0;
    }
  },
};

export const transformSystem: PreviewSystem = {
  name: "transform",
  run({ entities }) {
    for (const entity of entities) {
      if (entity.kind === "video") {
        entity.transform.scaleX = Math.max(0.01, entity.transform.scaleX);
        entity.transform.scaleY = Math.max(0.01, entity.transform.scaleY);
      }
    }
  },
};

export const videoSystem: PreviewSystem = {
  name: "video",
  run({ entities }) {
    for (const entity of entities) {
      if (entity.video && entity.timeline.active) {
        entity.video.requestedSourceTimeUs =
          entity.timeline.sourceStartUs + entity.timeline.localTimeUs;
      }
    }
  },
};

export const effectSystem: PreviewSystem = {
  name: "effect",
  run({ entities }) {
    for (const entity of entities) {
      entity.effects.resolved = resolveEffects(entity.effects.definitions);
    }
  },
};

export const renderSystem: PreviewSystem = {
  name: "render",
  run({ entities, renderTarget }) {
    const allEntities = [...entities];
    for (const entity of allEntities) {
      entity.render.visible = false;
    }
    if (!renderTarget) {
      return;
    }
    const visible = allEntities
      .filter((entity) => entity.timeline.active)
      .sort((left, right) => left.render.order - right.render.order);
    for (const entity of visible) {
      entity.render.visible = true;
    }
    renderTarget.sync(visible);
  },
};

export const PREVIEW_SYSTEMS: readonly PreviewSystem[] = [
  timelineSystem,
  animationSystem,
  transformSystem,
  videoSystem,
  effectSystem,
  renderSystem,
];

export function runPreviewSystems(context: SystemContext): void {
  for (const system of PREVIEW_SYSTEMS) {
    system.run(context);
  }
}
