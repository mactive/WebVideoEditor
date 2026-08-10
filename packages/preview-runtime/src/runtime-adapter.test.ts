import {
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from "@web-video-editor/domain";
import { describe, expect, it } from "vitest";

import { resolveEffects, resolveQualityProfile } from "./quality";
import { ProjectRuntimeAdapter } from "./runtime-adapter";
import { PREVIEW_SYSTEM_ORDER } from "./systems";
import type { RuntimeEntity } from "./types";

function project(): ProjectDocument {
  return {
    assets: [
      {
        durationUs: 10_000_000,
        fingerprint: "sha256:test",
        frameRate: 30,
        hasAudio: true,
        height: 720,
        id: "asset-1",
        name: "test_1.mp4",
        source: {
          kind: "test-asset",
          name: "test_1.mp4",
          size: 1,
        },
        width: 720,
      },
    ],
    canvas: {
      backgroundColor: "#000000",
      height: 1080,
      width: 1920,
    },
    clips: [
      {
        assetId: "asset-1",
        effects: [
          {
            amount: 0.8,
            enabled: true,
            id: "gray",
            kind: "grayscale",
          },
        ],
        id: "clip-1",
        sourceEndUs: 5_000_000,
        sourceStartUs: 1_000_000,
        timelineStartUs: 2_000_000,
        trackId: "video",
        transform: {
          rotationDeg: 18,
          scale: 0.6,
          x: 0.68,
          y: 0.62,
        },
      },
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    exportSettings: {
      audioBitrate: 192_000,
      audioCodec: "aac",
      frameRate: 60,
      height: 1080,
      videoBitrate: 8_000_000,
      videoCodec: "h264",
      width: 1920,
    },
    id: "project",
    name: "preview",
    revision: 1,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    texts: [
      {
        color: "#ffffff",
        endUs: 4_000_000,
        fontSize: 48,
        id: "title",
        rotationDeg: 15,
        scale: 1.2,
        startUs: 2_000_000,
        text: "真实标题",
        trackId: "text",
        x: 0.5,
        y: 0.25,
      },
    ],
    tracks: [
      {
        id: "video",
        kind: "video",
        locked: false,
        muted: false,
        name: "视频",
        order: 0,
      },
      {
        id: "text",
        kind: "text",
        locked: false,
        muted: false,
        name: "文字",
        order: 1,
      },
    ],
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

describe("ProjectRuntimeAdapter", () => {
  it("runs systems in the required order and evaluates source time", () => {
    expect(PREVIEW_SYSTEM_ORDER).toEqual([
      "timeline",
      "animation",
      "transform",
      "video",
      "effect",
      "render",
    ]);
    let rendered: readonly RuntimeEntity[] = [];
    const adapter = new ProjectRuntimeAdapter({
      renderTarget: {
        sync(entities) {
          rendered = entities;
        },
      },
    });

    const first = adapter.evaluate(project(), 2_500_000);
    expect(first).toMatchObject({
      created: 2,
      released: 0,
      updated: 0,
      video: {
        assetId: "asset-1",
        sourceTimeUs: 1_500_000,
      },
    });
    expect(rendered.map((entity) => entity.kind)).toEqual(["video", "text"]);
    expect(rendered[0]?.effects.resolved).toEqual([
      { amount: 0.8, id: "gray", kind: "grayscale" },
    ]);

    const second = adapter.evaluate(project(), 5_500_000);
    expect(second.created).toBe(0);
    expect(second.activeEntities).toHaveLength(1);
    expect(second.video?.sourceTimeUs).toBe(4_500_000);
  });

  it("updates and recycles entities when revision changes", () => {
    const adapter = new ProjectRuntimeAdapter();
    const initial = project();
    adapter.evaluate(initial, 0);
    const revised: ProjectDocument = {
      ...initial,
      revision: 2,
      texts: [],
    };

    const result = adapter.evaluate(revised, 0);
    expect(result).toMatchObject({
      created: 0,
      released: 1,
      updated: 1,
    });
    expect(adapter.world.size).toBe(1);
  });

  it("evaluates the same ECS systems with the original export profile", () => {
    let rendered: readonly RuntimeEntity[] = [];
    const adapter = new ProjectRuntimeAdapter({
      quality: "export",
      renderTarget: {
        sync(entities) {
          rendered = entities;
        },
      },
    });

    const result = adapter.evaluate(project(), 2_500_000);

    expect(result.video).toMatchObject({
      assetId: "asset-1",
      sourceTimeUs: 1_500_000,
    });
    expect(rendered[0]?.transform).toMatchObject({
      height: 1080,
      rotationRad: (18 * Math.PI) / 180,
      scaleX: 0.6,
      scaleY: 0.6,
      width: 1920,
      x: 1305.6000000000001,
      y: 669.6,
    });
    expect(rendered[1]?.text).toMatchObject({
      fontSize: 48,
      value: "真实标题",
    });
  });
});

describe("shared quality and effect semantics", () => {
  it("uses proxy preview and original export profiles", () => {
    const document = project();
    expect(resolveQualityProfile(document, "preview")).toEqual({
      frameRate: 30,
      height: 540,
      kind: "preview",
      mediaSource: "proxy",
      width: 960,
    });
    expect(resolveQualityProfile(document, "export")).toMatchObject({
      frameRate: 60,
      height: 1080,
      kind: "export",
      mediaSource: "original",
      width: 1920,
    });
  });

  it("drops disabled effects while preserving normalized parameters", () => {
    expect(
      resolveEffects([
        {
          amount: 1,
          enabled: false,
          id: "disabled",
          kind: "vintage",
        },
        {
          brightness: -0.25,
          contrast: 0.5,
          enabled: true,
          id: "adjust",
          kind: "adjustments",
        },
      ]),
    ).toEqual([
      {
        brightness: -0.25,
        contrast: 0.5,
        id: "adjust",
        kind: "adjustments",
      },
    ]);
  });
});
