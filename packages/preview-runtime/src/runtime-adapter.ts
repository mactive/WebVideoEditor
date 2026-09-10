import type { ProjectDocument } from "@web-video-editor/domain";
import type { StructuredLogger } from "@web-video-editor/observability";
import { World } from "miniplex";

import { resolveQualityProfile } from "./quality";
import { runPreviewSystems, type RuntimeRenderTarget } from "./systems";
import type { QualityProfile, RuntimeEntity, RuntimeEvaluation } from "./types";

function compileEntities(
  project: ProjectDocument,
  profile: QualityProfile,
): RuntimeEntity[] {
  const scale = profile.width / project.canvas.width;
  const trackById = new Map(project.tracks.map((track) => [track.id, track]));
  const renderOrder = (trackId: string) => trackById.get(trackId)?.order ?? 0;
  const clips = project.clips
    .filter((clip) => trackById.get(clip.trackId)?.kind === "video")
    .map((clip): RuntimeEntity => {
      const transform = clip.transform ?? {
        rotationDeg: 0,
        scale: 1,
        x: 0.5,
        y: 0.5,
      };
      return {
        animation: { opacity: 0 },
        effects: {
          definitions: clip.effects.map((effect) => ({ ...effect })),
          resolved: [],
        },
        id: `clip:${clip.id}`,
        kind: "video",
        render: {
          order: renderOrder(clip.trackId),
          visible: false,
        },
        timeline: {
          active: false,
          endUs: clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs,
          localTimeUs: 0,
          sourceStartUs: clip.sourceStartUs,
          startUs: clip.timelineStartUs,
        },
        transform: {
          height: profile.height,
          rotationRad: (transform.rotationDeg * Math.PI) / 180,
          scaleX: transform.scale,
          scaleY: transform.scale,
          width: profile.width,
          x: transform.x * profile.width,
          y: transform.y * profile.height,
        },
        video: {
          assetId: clip.assetId,
          requestedSourceTimeUs: clip.sourceStartUs,
        },
      };
    });
  const texts = project.texts
    .filter((text) => trackById.get(text.trackId)?.kind === "text")
    .map((text): RuntimeEntity => ({
      animation: { opacity: 0 },
      effects: { definitions: [], resolved: [] },
      id: `text:${text.id}`,
      kind: "text",
      render: {
        order: renderOrder(text.trackId),
        visible: false,
      },
      text: {
        backgroundColor: text.backgroundColor,
        backgroundOpacity: text.backgroundOpacity,
        color: text.color,
        fontFamily: text.fontFamily,
        fontSize: text.fontSize * scale,
        strokeColor: text.strokeColor,
        strokeWidth: text.strokeWidth * scale,
        value: text.text,
      },
      timeline: {
        active: false,
        endUs: text.endUs,
        localTimeUs: 0,
        sourceStartUs: 0,
        startUs: text.startUs,
      },
      transform: {
        height: 0,
        rotationRad: (text.rotationDeg * Math.PI) / 180,
        scaleX: text.scale,
        scaleY: text.scale,
        width: 0,
        x: text.x * profile.width,
        y: text.y * profile.height,
      },
    }));
  return [...clips, ...texts];
}

export type RuntimeAdapterOptions = {
  logger?: StructuredLogger;
  quality?: QualityProfile["kind"];
  renderTarget?: RuntimeRenderTarget;
};

export class ProjectRuntimeAdapter {
  readonly world = new World<RuntimeEntity>();

  private readonly entities = new Map<string, RuntimeEntity>();
  private revision = -1;
  private profile?: QualityProfile;

  constructor(private readonly options: RuntimeAdapterOptions = {}) {}

  evaluate(
    project: ProjectDocument,
    playheadUs: number,
    requestId?: string,
  ): RuntimeEvaluation {
    if (!Number.isSafeInteger(playheadUs) || playheadUs < 0) {
      throw new RangeError("playheadUs must be a non-negative safe integer");
    }
    const profile = resolveQualityProfile(
      project,
      this.options.quality ?? "preview",
    );
    const counts =
      project.revision === this.revision &&
      this.profile?.width === profile.width &&
      this.profile.height === profile.height
        ? { created: 0, released: 0, updated: 0 }
        : this.rebuild(project, profile, requestId);

    runPreviewSystems({
      entities: this.world,
      playheadUs,
      profile,
      renderTarget: this.options.renderTarget,
    });
    const activeEntities = [...this.world]
      .filter((entity) => entity.timeline.active)
      .sort((left, right) => left.render.order - right.render.order);
    const activeVideos = activeEntities.flatMap((entity) =>
      entity.video
        ? [
            {
              assetId: entity.video.assetId,
              entityId: entity.id,
              order: entity.render.order,
              sourceTimeUs: entity.video.requestedSourceTimeUs,
            },
          ]
        : [],
    );
    const evaluation: RuntimeEvaluation = {
      activeEntities,
      activeVideos,
      ...counts,
      playheadUs,
      revision: project.revision,
      video: activeVideos[0]
        ? {
            assetId: activeVideos[0].assetId,
            entityId: activeVideos[0].entityId,
            sourceTimeUs: activeVideos[0].sourceTimeUs,
          }
        : undefined,
    };
    this.options.logger?.log({
      event: "evaluate",
      input: { playheadUs },
      level: "debug",
      marker: "[ECS]",
      output: {
        activeEntities: activeEntities.length,
        created: counts.created,
        released: counts.released,
        updated: counts.updated,
      },
      projectRevision: project.revision,
      requestId,
    });
    return evaluation;
  }

  dispose(): void {
    for (const entity of [...this.world]) {
      this.release(entity);
    }
    this.entities.clear();
    this.revision = -1;
    this.profile = undefined;
  }

  private rebuild(
    project: ProjectDocument,
    profile: QualityProfile,
    requestId?: string,
  ): { created: number; released: number; updated: number } {
    const desired = new Map(
      compileEntities(project, profile).map((entity) => [entity.id, entity]),
    );
    let created = 0;
    let released = 0;
    let updated = 0;

    for (const [id, entity] of this.entities) {
      if (!desired.has(id)) {
        this.release(entity, requestId);
        this.entities.delete(id);
        released += 1;
      }
    }
    for (const [id, candidate] of desired) {
      const existing = this.entities.get(id);
      if (existing) {
        this.world.update(existing, candidate);
        updated += 1;
      } else {
        this.world.add(candidate);
        this.entities.set(id, candidate);
        created += 1;
      }
    }

    const previousRevision = this.revision;
    this.revision = project.revision;
    this.profile = profile;
    this.options.logger?.log({
      event: "revision.rebuilt",
      input: { previousRevision },
      level: "info",
      marker: "[ECS]",
      output: { created, released, updated },
      projectRevision: project.revision,
      requestId,
    });
    return { created, released, updated };
  }

  private release(entity: RuntimeEntity, requestId?: string): void {
    this.world.remove(entity);
    this.options.logger?.log({
      event: "entity.released",
      input: { entityId: entity.id, kind: entity.kind },
      level: "debug",
      marker: "[ECS]",
      output: { resources: 0 },
      projectRevision: this.revision >= 0 ? this.revision : undefined,
      requestId,
    });
  }
}
