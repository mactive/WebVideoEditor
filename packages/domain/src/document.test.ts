import { describe, expect, it } from "vitest";

import { migrateProjectDocument } from "./migrations";
import {
  assertPureJson,
  deserializeProjectDocument,
  NonJsonValueError,
  serializeProjectDocument,
} from "./serialization";
import { createTestProject } from "./test-fixture";
import { validateProjectDocument } from "./validation";

function addAudioTrack(
  project: ReturnType<typeof createTestProject>,
  id: string,
): void {
  project.tracks.push({
    id,
    kind: "audio",
    name: id,
    order: Math.max(-1, ...project.tracks.map((track) => track.order)) + 1,
    muted: false,
    locked: false,
  });
}

describe("Project Document", () => {
  it("validates schema and cross-entity invariants", () => {
    expect(validateProjectDocument(createTestProject())).toEqual({
      success: true,
      data: createTestProject(),
      issues: [],
    });

    const invalid = createTestProject();
    invalid.clips[1]!.timelineStartUs = 4_000_000;
    invalid.clips[1]!.assetId = "missing";
    const result = validateProjectDocument(invalid);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(["invalid_reference", "overlap"]),
      );
    }
  });

  it("rejects out-of-range clip boundaries", () => {
    const project = createTestProject();
    project.clips[0]!.sourceEndUs = 21_000_000;

    const result = validateProjectDocument(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid_boundary",
          path: "clips.0.sourceEndUs",
        }),
      );
    }
  });

  it("allows the same asset to overlap on different video tracks", () => {
    const project = createTestProject();
    project.tracks.push({
      id: "video-2",
      kind: "video",
      name: "视频 2",
      order: 2,
      muted: false,
      locked: false,
    });
    project.clips.push({
      id: "clip-overlap-video-2",
      assetId: "asset-1",
      trackId: "video-2",
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 5_000_000,
      effects: [],
    });

    expect(validateProjectDocument(project)).toEqual({
      success: true,
      data: project,
      issues: [],
    });
  });

  it("rejects overlapping clips on the same video track", () => {
    const project = createTestProject();
    project.clips.push({
      id: "clip-overlap-video-1",
      assetId: "asset-1",
      trackId: "video-1",
      timelineStartUs: 1_000_000,
      sourceStartUs: 0,
      sourceEndUs: 5_000_000,
      effects: [],
    });

    const result = validateProjectDocument(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "overlap",
          path: "clips.clip-overlap-video-1",
        }),
      );
    }
  });

  it("allows the same asset to be added repeatedly to an audio track", () => {
    const project = createTestProject();
    addAudioTrack(project, "audio-1");
    project.clips.push(
      {
        id: "audio-clip-1",
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
      {
        id: "audio-clip-2",
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 5_000_000,
        sourceStartUs: 5_000_000,
        sourceEndUs: 10_000_000,
        effects: [],
      },
    );

    expect(validateProjectDocument(project)).toEqual({
      success: true,
      data: project,
      issues: [],
    });
  });

  it("allows overlapping clips on different audio tracks", () => {
    const project = createTestProject();
    addAudioTrack(project, "audio-1");
    addAudioTrack(project, "audio-2");
    project.clips.push(
      {
        id: "audio-overlap-1",
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
      {
        id: "audio-overlap-2",
        assetId: "asset-1",
        trackId: "audio-2",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
    );

    expect(validateProjectDocument(project)).toEqual({
      success: true,
      data: project,
      issues: [],
    });
  });

  it("rejects overlapping clips on the same audio track", () => {
    const project = createTestProject();
    addAudioTrack(project, "audio-1");
    project.clips.push(
      {
        id: "audio-overlap-1",
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
      {
        id: "audio-overlap-2",
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 1_000_000,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
    );

    const result = validateProjectDocument(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "overlap",
          path: "clips.audio-overlap-2",
        }),
      );
    }
  });

  it("rejects audio track clips that reference assets without audio", () => {
    const project = createTestProject();
    addAudioTrack(project, "audio-1");
    project.assets.push({
      ...project.assets[0]!,
      id: "silent-asset",
      fingerprint: "sha256:silent",
      hasAudio: false,
    });
    project.clips.push({
      id: "silent-audio-clip",
      assetId: "silent-asset",
      trackId: "audio-1",
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 5_000_000,
      effects: [],
    });

    const result = validateProjectDocument(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code: "invalid_reference",
          path: "clips.2.assetId",
        }),
      );
    }
  });

  it("rejects media clips that reference a text track", () => {
    const project = createTestProject();
    project.clips[0]!.trackId = "text-1";
    project.clips[1]!.trackId = "text-1";

    const result = validateProjectDocument(project);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "invalid_reference",
            path: "clips.0.trackId",
          }),
          expect.objectContaining({
            code: "invalid_reference",
            path: "clips.1.trackId",
          }),
        ]),
      );
    }
  });

  it("migrates version 0 and rejects future versions", () => {
    const current = createTestProject();
    const versionZero = {
      ...current,
      schemaVersion: 0,
      canvas: {
        width: current.canvas.width,
        height: current.canvas.height,
      },
    };

    const migrated = migrateProjectDocument(versionZero);

    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.canvas.backgroundColor).toBe("#000000");
    expect(() =>
      migrateProjectDocument({ ...current, schemaVersion: 2 }),
    ).toThrow("不支持 schemaVersion 2");
  });

  it("rejects malformed and invariant-breaking migration inputs", () => {
    const current = createTestProject();
    expect(() => migrateProjectDocument({ name: "missing version" })).toThrow(
      "缺少有效的 schemaVersion",
    );
    expect(() =>
      migrateProjectDocument({
        ...current,
        schemaVersion: 0,
        canvas: {
          height: current.canvas.height,
          width: current.canvas.width,
        },
        clips: [
          ...current.clips,
          {
            ...current.clips[0],
            id: "overlapping-after-migration",
            timelineStartUs: 1,
          },
        ],
      }),
    ).toThrow("重叠");
  });

  it("reports duplicate IDs and invalid text track references together", () => {
    const invalid = createTestProject();
    invalid.assets.push({ ...invalid.assets[0]! });
    invalid.texts[0]!.trackId = "video-1";

    const result = validateProjectDocument(invalid);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "duplicate_id",
            path: "assets.1.id",
          }),
          expect.objectContaining({
            code: "invalid_reference",
            path: "texts.0.trackId",
          }),
        ]),
      );
    }
  });

  it("round-trips as pure JSON", () => {
    const project = createTestProject();
    const json = serializeProjectDocument(project);

    expect(deserializeProjectDocument(json)).toEqual(project);
    expect(JSON.parse(json)).toEqual(project);
  });

  it("rejects runtime and non-finite values before serialization", () => {
    expect(() => assertPureJson({ file: new Blob(["media"]) })).toThrow(
      NonJsonValueError,
    );
    expect(() => assertPureJson({ bytes: new Uint8Array([1, 2]) })).toThrow(
      NonJsonValueError,
    );
    expect(() => assertPureJson({ duration: Number.NaN })).toThrow(
      NonJsonValueError,
    );
  });
});
