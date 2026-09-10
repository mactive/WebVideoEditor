import { describe, expect, it } from "vitest";

import { CommandBus, type CommandEvent } from "./command-bus";
import { applyProjectCommand, type ProjectCommand } from "./commands";
import {
  createProjectDocument,
  MIN_CLIP_DURATION_US,
  MIN_TEXT_DURATION_US,
} from "./project";
import {
  DEFAULT_TEXT_BACKGROUND_COLOR,
  DEFAULT_TEXT_BACKGROUND_OPACITY,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_STROKE_COLOR,
  DEFAULT_TEXT_STROKE_WIDTH,
} from "./schema";
import { createTestProject } from "./test-fixture";

const now = "2026-08-09T01:00:00.000Z";

function addTrack(
  project: ReturnType<typeof createTestProject>,
  id: string,
  kind: "audio" | "text" | "video",
): void {
  project.tracks.push({
    id,
    kind,
    name: id,
    order: project.tracks.length,
    muted: false,
    locked: false,
  });
}

function addAudioClip(
  project: ReturnType<typeof createTestProject>,
  overrides: Partial<
    ReturnType<typeof createTestProject>["clips"][number]
  > = {},
): void {
  const trackId = overrides.trackId ?? "audio-1";
  if (!project.tracks.some((track) => track.id === trackId)) {
    addTrack(project, trackId, "audio");
  }
  project.clips.push({
    id: "audio-clip-1",
    assetId: "asset-1",
    trackId,
    timelineStartUs: 0,
    sourceStartUs: 0,
    sourceEndUs: 5_000_000,
    effects: [],
    ...overrides,
  });
}

describe("project commands", () => {
  it("adapts only an empty project canvas to the first asset display size", () => {
    const empty = createTestProject();
    empty.assets = [];
    empty.clips = [];
    const portrait = {
      durationUs: 5_000_000,
      fingerprint: "sha256:portrait",
      frameRate: 30,
      hasAudio: true,
      height: 1920,
      id: "portrait",
      name: "test_3.mp4",
      source: {
        kind: "test-asset" as const,
        name: "test_3.mp4",
        size: 1024,
      },
      width: 1080,
    };

    const first = applyProjectCommand(empty, {
      adaptCanvasToAsset: true,
      asset: portrait,
      type: "asset.add",
    });
    expect(first.canvas).toMatchObject({ height: 1920, width: 1080 });

    const second = applyProjectCommand(first, {
      adaptCanvasToAsset: true,
      asset: { ...portrait, id: "landscape", width: 1920, height: 1080 },
      type: "asset.add",
    });
    expect(second.canvas).toMatchObject({ height: 1920, width: 1080 });
  });

  it.each<{
    command: ProjectCommand;
    verify: (project: ReturnType<typeof createTestProject>) => void;
  }>([
    {
      command: {
        type: "asset.add",
        asset: {
          id: "asset-2",
          name: "imported.mp4",
          fingerprint: "sha256:imported",
          durationUs: 2_000_000,
          width: 1280,
          height: 720,
          frameRate: 30,
          hasAudio: false,
          source: {
            kind: "file",
            name: "imported.mp4",
            size: 2048,
          },
        },
      },
      verify: (project) =>
        expect(project.assets.map((asset) => asset.id)).toEqual([
          "asset-1",
          "asset-2",
        ]),
    },
    {
      command: {
        type: "track.audio.add",
        trackId: "audio-1",
      },
      verify: (project) =>
        expect(project.tracks.at(-1)).toEqual({
          id: "audio-1",
          kind: "audio",
          name: "音频",
          order: 2,
          muted: false,
          locked: false,
        }),
    },
    {
      command: {
        type: "track.video.add",
        trackId: "video-2",
      },
      verify: (project) =>
        expect(project.tracks.at(-1)).toEqual({
          id: "video-2",
          kind: "video",
          name: "视频 2",
          order: 2,
          muted: false,
          locked: false,
        }),
    },
    {
      command: {
        type: "track.text.add",
      },
      verify: (project) =>
        expect(project.tracks.at(-1)).toEqual({
          id: "text-track-2",
          kind: "text",
          name: "文字 2",
          order: 2,
          muted: false,
          locked: false,
        }),
    },
    {
      command: {
        type: "clip.add",
        clip: {
          id: "clip-3",
          assetId: "asset-1",
          trackId: "video-1",
          timelineStartUs: 12_000_000,
          sourceStartUs: 0,
          sourceEndUs: 1_000_000,
          effects: [],
        },
      },
      verify: (project) =>
        expect(project.clips.map((clip) => clip.id)).toEqual([
          "clip-1",
          "clip-2",
          "clip-3",
        ]),
    },
    {
      command: {
        type: "clip.move",
        clipId: "clip-2",
        timelineStartUs: 7_000_000,
      },
      verify: (project) =>
        expect(project.clips[1]?.timelineStartUs).toBe(7_000_000),
    },
    {
      command: {
        type: "clip.trim",
        clipId: "clip-1",
        timelineStartUs: 1_000_000,
        sourceStartUs: 1_000_000,
        sourceEndUs: 4_000_000,
      },
      verify: (project) =>
        expect(project.clips[0]).toEqual(
          expect.objectContaining({
            timelineStartUs: 1_000_000,
            sourceStartUs: 1_000_000,
            sourceEndUs: 4_000_000,
          }),
        ),
    },
    {
      command: {
        type: "clip.transform",
        clipId: "clip-1",
        transform: {
          rotationDeg: 18,
          scale: 0.6,
          x: 0.68,
          y: 0.62,
        },
      },
      verify: (project) =>
        expect(project.clips[0]?.transform).toEqual({
          rotationDeg: 18,
          scale: 0.6,
          x: 0.68,
          y: 0.62,
        }),
    },
    {
      command: {
        type: "clip.split",
        clipId: "clip-1",
        rightClipId: "clip-right",
        timelineUs: 2_000_000,
      },
      verify: (project) => {
        expect(project.clips[0]?.sourceEndUs).toBe(2_000_000);
        expect(project.clips[1]).toEqual(
          expect.objectContaining({
            id: "clip-right",
            timelineStartUs: 2_000_000,
            sourceStartUs: 2_000_000,
            sourceEndUs: 5_000_000,
          }),
        );
      },
    },
    {
      command: { type: "clip.delete", clipId: "clip-1" },
      verify: (project) =>
        expect(project.clips.map((clip) => clip.id)).toEqual(["clip-2"]),
    },
    {
      command: {
        type: "text.add",
        text: {
          id: "title-2",
          trackId: "text-1",
          text: "新增标题",
          startUs: 5_000_000,
          endUs: 6_000_000,
          fontSize: 48,
          color: "#ffffff",
          x: 0.5,
          y: 0.5,
          scale: 1,
          rotationDeg: 0,
        },
      },
      verify: (project) =>
        expect(project.texts[1]).toEqual(
          expect.objectContaining({
            id: "title-2",
            fontFamily: DEFAULT_TEXT_FONT_FAMILY,
            strokeColor: DEFAULT_TEXT_STROKE_COLOR,
            strokeWidth: DEFAULT_TEXT_STROKE_WIDTH,
            backgroundColor: DEFAULT_TEXT_BACKGROUND_COLOR,
            backgroundOpacity: DEFAULT_TEXT_BACKGROUND_OPACITY,
          }),
        ),
    },
    {
      command: { type: "text.delete", textId: "title-1" },
      verify: (project) => expect(project.texts).toEqual([]),
    },
    {
      command: {
        type: "text.update",
        textId: "title-1",
        patch: {
          text: "新标题",
          startUs: 1_000_000,
          endUs: 4_000_000,
          fontFamily: "Arial, sans-serif",
          fontSize: 56,
          color: "#ffcc00",
          strokeColor: "#101010",
          strokeWidth: 3,
          backgroundColor: "#202020",
          backgroundOpacity: 0.5,
          rotationDeg: 15,
        },
      },
      verify: (project) =>
        expect(project.texts[0]).toEqual(
          expect.objectContaining({
            text: "新标题",
            startUs: 1_000_000,
            endUs: 4_000_000,
            fontFamily: "Arial, sans-serif",
            fontSize: 56,
            color: "#ffcc00",
            strokeColor: "#101010",
            strokeWidth: 3,
            backgroundColor: "#202020",
            backgroundOpacity: 0.5,
            rotationDeg: 15,
          }),
        ),
    },
    {
      command: {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: {
          id: "effect-1",
          kind: "grayscale",
          enabled: true,
          amount: 0.75,
        },
      },
      verify: (project) =>
        expect(project.clips[0]?.effects).toEqual([
          {
            id: "effect-1",
            kind: "grayscale",
            enabled: true,
            amount: 0.75,
          },
        ]),
    },
    {
      command: {
        type: "track.reorder",
        trackIds: ["text-1", "video-1"],
      },
      verify: (project) =>
        expect(project.tracks.map((track) => [track.id, track.order])).toEqual([
          ["video-1", 1],
          ["text-1", 0],
        ]),
    },
    {
      command: {
        type: "timeline.duration.set",
        durationUs: 60_000_000,
      },
      verify: (project) => expect(project.timeline.durationUs).toBe(60_000_000),
    },
  ])("applies $command.type without mutating input", ({ command, verify }) => {
    const original = createTestProject();
    const snapshot = structuredClone(original);

    const result = applyProjectCommand(original, command, now);

    verify(result);
    expect(result.revision).toBe(1);
    expect(result.updatedAt).toBe(now);
    expect(original).toEqual(snapshot);
  });

  it("removes an effect through effect.set", () => {
    const withEffect = applyProjectCommand(
      createTestProject(),
      {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: {
          id: "effect-1",
          kind: "vintage",
          enabled: true,
          amount: 1,
        },
      },
      now,
    );

    const result = applyProjectCommand(
      withEffect,
      {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: null,
      },
      now,
    );

    expect(result.clips[0]?.effects).toEqual([]);
  });

  it("checks invariants before committing a command", () => {
    expect(() =>
      applyProjectCommand(
        createTestProject(),
        {
          type: "clip.move",
          clipId: "clip-2",
          timelineStartUs: 4_000_000,
        },
        now,
      ),
    ).toThrow("重叠");
  });

  it("clamps configured timeline duration to the content end", () => {
    const project = createTestProject();
    project.texts[0]!.endUs = 15_000_000;
    project.timeline.durationUs = 15_000_000;

    const result = applyProjectCommand(
      project,
      {
        type: "timeline.duration.set",
        durationUs: 1_000_000,
      },
      now,
    );

    expect(result.timeline.durationUs).toBe(15_000_000);
  });

  it("trims a video clip start while keeping its timeline right edge stable", () => {
    const project = createTestProject();
    const rightEdgeUs =
      project.clips[0]!.timelineStartUs +
      project.clips[0]!.sourceEndUs -
      project.clips[0]!.sourceStartUs;

    const result = applyProjectCommand(
      project,
      {
        type: "clip.trim",
        clipId: "clip-1",
        timelineStartUs: 2_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 5_000_000,
      },
      now,
    );
    const clip = result.clips[0]!;

    expect(clip).toEqual(
      expect.objectContaining({
        timelineStartUs: 2_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 5_000_000,
      }),
    );
    expect(clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs).toBe(
      rightEdgeUs,
    );
  });

  it("extends a video clip up to the next same-track clip boundary", () => {
    const result = applyProjectCommand(
      createTestProject(),
      {
        type: "clip.trim",
        clipId: "clip-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 6_000_000,
      },
      now,
    );

    expect(result.clips[0]).toEqual(
      expect.objectContaining({
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 6_000_000,
      }),
    );
  });

  it("trims an audio clip with the same source and timeline semantics", () => {
    const project = createTestProject();
    addAudioClip(project);

    const result = applyProjectCommand(
      project,
      {
        type: "clip.trim",
        clipId: "audio-clip-1",
        timelineStartUs: 2_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 7_000_000,
      },
      now,
    );

    expect(result.clips.find((clip) => clip.id === "audio-clip-1")).toEqual(
      expect.objectContaining({
        trackId: "audio-1",
        timelineStartUs: 2_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 7_000_000,
      }),
    );
  });

  it.each([
    {
      name: "empty source range",
      command: {
        type: "clip.trim" as const,
        clipId: "clip-1",
        timelineStartUs: 0,
        sourceStartUs: 2_000_000,
        sourceEndUs: 2_000_000,
      },
      message: "sourceStartUs 必须小于 sourceEndUs",
    },
    {
      name: "shorter than minimum duration",
      command: {
        type: "clip.trim" as const,
        clipId: "clip-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: MIN_CLIP_DURATION_US - 1,
      },
      message: "片段时长不能短于",
    },
    {
      name: "past asset duration",
      command: {
        type: "clip.trim" as const,
        clipId: "clip-1",
        timelineStartUs: 0,
        sourceStartUs: 19_000_000,
        sourceEndUs: 21_000_000,
      },
      message: "片段源结束时间超出素材时长",
    },
  ])("rejects invalid clip.trim boundaries: $name", ({ command, message }) => {
    const project = createTestProject();

    expect(() => applyProjectCommand(project, command, now)).toThrow(message);
    expect(project).toEqual(createTestProject());
  });

  it("rejects trimming into another clip on the same track", () => {
    const project = createTestProject();

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "clip.trim",
          clipId: "clip-1",
          timelineStartUs: 0,
          sourceStartUs: 0,
          sourceEndUs: 6_000_001,
        },
        now,
      ),
    ).toThrow("重叠");
    expect(project).toEqual(createTestProject());
  });

  it("allows trimming to overlap clips on a different video track", () => {
    const project = createTestProject();
    project.clips = [project.clips[0]!];
    addTrack(project, "video-2", "video");
    project.clips.push({
      id: "clip-on-video-2",
      assetId: "asset-1",
      trackId: "video-2",
      timelineStartUs: 2_000_000,
      sourceStartUs: 0,
      sourceEndUs: 5_000_000,
      effects: [],
    });

    const result = applyProjectCommand(
      project,
      {
        type: "clip.trim",
        clipId: "clip-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 8_000_000,
      },
      now,
    );

    expect(result.clips.find((clip) => clip.id === "clip-1")).toEqual(
      expect.objectContaining({ sourceEndUs: 8_000_000 }),
    );
  });

  it("splits a clip without sharing mutable effect or transform references", () => {
    const project = createTestProject();
    project.clips[0]!.effects = [
      {
        id: "effect-1",
        kind: "adjustments",
        enabled: true,
        brightness: 0.1,
        contrast: 0.2,
      },
    ];
    project.clips[0]!.transform = {
      rotationDeg: 12,
      scale: 0.8,
      x: 0.4,
      y: 0.6,
    };

    const result = applyProjectCommand(
      project,
      {
        type: "clip.split",
        clipId: "clip-1",
        rightClipId: "clip-right",
        timelineUs: 2_000_000,
      },
      now,
    );
    const left = result.clips.find((clip) => clip.id === "clip-1")!;
    const right = result.clips.find((clip) => clip.id === "clip-right")!;

    expect(left).toEqual(
      expect.objectContaining({
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 2_000_000,
      }),
    );
    expect(right).toEqual(
      expect.objectContaining({
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 2_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 5_000_000,
        effects: left.effects,
        transform: left.transform,
      }),
    );
    expect(right.effects).not.toBe(left.effects);
    expect(right.effects[0]).not.toBe(left.effects[0]);
    expect(right.transform).not.toBe(left.transform);
  });

  it("splits an audio clip using the same timeline-to-source mapping", () => {
    const project = createTestProject();
    addAudioClip(project, {
      timelineStartUs: 4_000_000,
      sourceStartUs: 2_000_000,
      sourceEndUs: 7_000_000,
    });

    const result = applyProjectCommand(
      project,
      {
        type: "clip.split",
        clipId: "audio-clip-1",
        rightClipId: "audio-clip-right",
        timelineUs: 5_500_000,
      },
      now,
    );

    expect(result.clips.find((clip) => clip.id === "audio-clip-1")).toEqual(
      expect.objectContaining({
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 4_000_000,
        sourceStartUs: 2_000_000,
        sourceEndUs: 3_500_000,
      }),
    );
    expect(result.clips.find((clip) => clip.id === "audio-clip-right")).toEqual(
      expect.objectContaining({
        assetId: "asset-1",
        trackId: "audio-1",
        timelineStartUs: 5_500_000,
        sourceStartUs: 3_500_000,
        sourceEndUs: 7_000_000,
      }),
    );
  });

  it("rejects splits that would create clips shorter than the minimum duration", () => {
    const project = createTestProject();

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "clip.split",
          clipId: "clip-1",
          rightClipId: "clip-right",
          timelineUs: MIN_CLIP_DURATION_US - 1,
        },
        now,
      ),
    ).toThrow("分割后的片段时长不能短于");
    expect(project).toEqual(createTestProject());
  });

  it("moves audio clips across same-kind tracks", () => {
    const project = createTestProject();
    addAudioClip(project);
    addTrack(project, "audio-2", "audio");
    project.clips.push({
      id: "audio-clip-2",
      assetId: "asset-1",
      trackId: "audio-2",
      timelineStartUs: 2_000_000,
      sourceStartUs: 5_000_000,
      sourceEndUs: 10_000_000,
      effects: [],
    });

    const result = applyProjectCommand(
      project,
      {
        type: "clip.move",
        clipId: "audio-clip-1",
        trackId: "audio-2",
        timelineStartUs: 8_000_000,
      },
      now,
    );

    expect(result.clips.find((clip) => clip.id === "audio-clip-1")).toEqual(
      expect.objectContaining({
        trackId: "audio-2",
        timelineStartUs: 8_000_000,
      }),
    );
  });

  it("rejects moving audio clips into a same-track conflict", () => {
    const project = createTestProject();
    addAudioClip(project);
    project.clips.push({
      id: "audio-clip-2",
      assetId: "asset-1",
      trackId: "audio-1",
      timelineStartUs: 6_000_000,
      sourceStartUs: 5_000_000,
      sourceEndUs: 10_000_000,
      effects: [],
    });

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "clip.move",
          clipId: "audio-clip-2",
          trackId: "audio-1",
          timelineStartUs: 4_000_000,
        },
        now,
      ),
    ).toThrow("重叠");
  });

  it("normalizes track order after reordering", () => {
    const result = applyProjectCommand(
      createTestProject(),
      {
        type: "track.reorder",
        trackIds: ["text-1", "video-1"],
      },
      now,
    );

    expect(result.tracks.map((track) => [track.id, track.order])).toEqual([
      ["video-1", 1],
      ["text-1", 0],
    ]);
  });

  it("deletes empty tracks and normalizes remaining order", () => {
    const project = createTestProject();
    addTrack(project, "video-2", "video");

    const result = applyProjectCommand(
      project,
      { type: "track.delete", trackId: "video-2" },
      now,
    );

    expect(result.tracks.map((track) => [track.id, track.order])).toEqual([
      ["video-1", 0],
      ["text-1", 1],
    ]);
  });

  it("cascades track contents only after confirmation", () => {
    const project = createTestProject();
    addTrack(project, "video-2", "video");
    project.clips.push({
      id: "clip-on-video-2",
      assetId: "asset-1",
      trackId: "video-2",
      timelineStartUs: 0,
      sourceStartUs: 0,
      sourceEndUs: 2_000_000,
      effects: [],
    });

    expect(() =>
      applyProjectCommand(
        project,
        { type: "track.delete", trackId: "video-2" },
        now,
      ),
    ).toThrow("轨道包含内容");

    const result = applyProjectCommand(
      project,
      { type: "track.delete", trackId: "video-2", cascade: true },
      now,
    );

    expect(result.tracks.map((track) => track.id)).toEqual([
      "video-1",
      "text-1",
    ]);
    expect(result.clips.map((clip) => clip.id)).toEqual(["clip-1", "clip-2"]);
  });

  it("cascades text track contents after confirmation", () => {
    const project = createTestProject();
    addTrack(project, "text-2", "text");
    project.texts[0]!.trackId = "text-2";

    const result = applyProjectCommand(
      project,
      { type: "track.delete", trackId: "text-2", cascade: true },
      now,
    );

    expect(result.tracks.map((track) => track.id)).toEqual([
      "video-1",
      "text-1",
    ]);
    expect(result.texts).toEqual([]);
  });

  it("blocks deleting the last track of the same kind", () => {
    expect(() =>
      applyProjectCommand(
        createTestProject(),
        { type: "track.delete", trackId: "text-1" },
        now,
      ),
    ).toThrow("不能删除最后一条文字轨道");
  });

  it("moves a clip across same-kind tracks", () => {
    const project = createTestProject();
    addTrack(project, "video-2", "video");

    const result = applyProjectCommand(
      project,
      {
        type: "clip.move",
        clipId: "clip-2",
        trackId: "video-2",
        timelineStartUs: 1_000_000,
      },
      now,
    );

    expect(result.clips[1]).toEqual(
      expect.objectContaining({
        id: "clip-2",
        trackId: "video-2",
        timelineStartUs: 1_000_000,
      }),
    );
  });

  it("rejects moving a clip to a different media kind", () => {
    const project = createTestProject();
    addTrack(project, "audio-1", "audio");

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "clip.move",
          clipId: "clip-1",
          trackId: "audio-1",
          timelineStartUs: 0,
        },
        now,
      ),
    ).toThrow("片段只能移动到同类型媒体轨道");
  });

  it("rejects moving a clip into a target track conflict", () => {
    const project = createTestProject();
    addTrack(project, "video-2", "video");
    project.clips.push({
      id: "clip-on-video-2",
      assetId: "asset-1",
      trackId: "video-2",
      timelineStartUs: 2_000_000,
      sourceStartUs: 0,
      sourceEndUs: 7_000_000,
      effects: [],
    });

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "clip.move",
          clipId: "clip-2",
          trackId: "video-2",
          timelineStartUs: 3_000_000,
        },
        now,
      ),
    ).toThrow("重叠");
  });

  it("updates text tracks through text.update patches", () => {
    const project = createTestProject();
    addTrack(project, "text-2", "text");

    const result = applyProjectCommand(
      project,
      {
        type: "text.update",
        textId: "title-1",
        patch: { trackId: "text-2", startUs: 1_000_000, endUs: 4_000_000 },
      },
      now,
    );

    expect(result.texts[0]).toEqual(
      expect.objectContaining({
        trackId: "text-2",
        startUs: 1_000_000,
        endUs: 4_000_000,
      }),
    );
  });

  it("rejects text.update patches with invalid time ranges", () => {
    expect(() =>
      applyProjectCommand(
        createTestProject(),
        {
          type: "text.update",
          textId: "title-1",
          patch: { startUs: 4_000_000, endUs: 4_000_000 },
        },
        now,
      ),
    ).toThrow("文字开始时间必须小于结束时间");
  });

  it("rejects text.add and text.update results shorter than the minimum duration", () => {
    const shortEndUs = MIN_TEXT_DURATION_US - 1;
    expect(() =>
      applyProjectCommand(
        createTestProject(),
        {
          type: "text.add",
          text: {
            id: "short-title",
            trackId: "text-1",
            text: "短标题",
            startUs: 0,
            endUs: shortEndUs,
            fontSize: 48,
            color: "#ffffff",
            x: 0.5,
            y: 0.5,
            scale: 1,
            rotationDeg: 0,
          },
        },
        now,
      ),
    ).toThrow("文字时长不能短于");

    const bus = new CommandBus(createTestProject(), { now: () => now });
    expect(() =>
      bus.execute({
        type: "text.update",
        textId: "title-1",
        patch: { endUs: shortEndUs },
      }),
    ).toThrow("文字时长不能短于");
    expect(bus.document).toEqual(createTestProject());
  });

  it("rejects text updates that overlap another text on the same track", () => {
    const project = createTestProject();
    project.texts.push({
      ...project.texts[0]!,
      id: "title-2",
      startUs: 3_000_000,
      endUs: 5_000_000,
    });

    expect(() =>
      applyProjectCommand(
        project,
        {
          type: "text.update",
          textId: "title-2",
          patch: { startUs: 2_000_000, endUs: 5_000_000 },
        },
        now,
      ),
    ).toThrow("重叠");
  });
});

describe("CommandBus", () => {
  it.each<ProjectCommand>([
    {
      type: "asset.add",
      asset: {
        id: "asset-2",
        name: "imported.mp4",
        fingerprint: "sha256:imported",
        durationUs: 2_000_000,
        width: 1280,
        height: 720,
        frameRate: 30,
        hasAudio: false,
        source: {
          kind: "file",
          name: "imported.mp4",
          size: 2048,
        },
      },
    },
    {
      type: "track.audio.add",
      trackId: "audio-1",
    },
    {
      type: "track.video.add",
      trackId: "video-2",
    },
    {
      type: "track.text.add",
    },
    {
      type: "clip.add",
      clip: {
        id: "clip-3",
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 12_000_000,
        sourceStartUs: 0,
        sourceEndUs: 1_000_000,
        effects: [],
      },
    },
    {
      type: "clip.move",
      clipId: "clip-2",
      timelineStartUs: 7_000_000,
    },
    {
      type: "track.reorder",
      trackIds: ["text-1", "video-1"],
    },
    {
      type: "timeline.duration.set",
      durationUs: 60_000_000,
    },
    {
      type: "clip.trim",
      clipId: "clip-1",
      timelineStartUs: 1_000_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 4_000_000,
    },
    {
      type: "clip.transform",
      clipId: "clip-1",
      transform: {
        rotationDeg: 18,
        scale: 0.6,
        x: 0.68,
        y: 0.62,
      },
    },
    {
      type: "clip.split",
      clipId: "clip-1",
      rightClipId: "clip-right",
      timelineUs: 2_000_000,
    },
    { type: "clip.delete", clipId: "clip-1" },
    {
      type: "text.add",
      text: {
        id: "title-2",
        trackId: "text-1",
        text: "新增标题",
        startUs: 5_000_000,
        endUs: 6_000_000,
        fontSize: 48,
        color: "#ffffff",
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotationDeg: 0,
      },
    },
    { type: "text.delete", textId: "title-1" },
    {
      type: "text.update",
      textId: "title-1",
      patch: { text: "Undo/Redo" },
    },
    {
      type: "effect.set",
      clipId: "clip-1",
      effectId: "effect-1",
      effect: {
        id: "effect-1",
        kind: "adjustments",
        enabled: true,
        brightness: 0.2,
        contrast: -0.1,
      },
    },
  ])("round-trips $type through undo and redo", (command) => {
    const initial = createTestProject();
    const bus = new CommandBus(initial, { now: () => now });

    const applied = bus.execute(command);

    expect(bus.undo()).toEqual(initial);
    expect(bus.redo()).toEqual(applied);
  });

  it("creates a valid video track with generated defaults", () => {
    const bus = new CommandBus(createTestProject(), { now: () => now });

    const result = bus.execute({ type: "track.video.add" });

    expect(result.tracks.at(-1)).toEqual({
      id: "video-track-2",
      kind: "video",
      name: "视频 2",
      order: 2,
      muted: false,
      locked: false,
    });
  });

  it("creates multiple valid audio tracks with generated and explicit IDs", () => {
    const project = createProjectDocument({
      id: "project-audio",
      name: "多音频轨工程",
      now,
    });
    const bus = new CommandBus(project, { now: () => now });

    let result = bus.execute({ type: "track.audio.add" });

    expect(result.tracks.at(-1)).toEqual({
      id: "audio-track-2",
      kind: "audio",
      name: "音频 2",
      order: 3,
      muted: false,
      locked: false,
    });

    result = bus.execute({ type: "track.audio.add", trackId: "audio-custom" });

    expect(result.tracks.at(-1)).toEqual({
      id: "audio-custom",
      kind: "audio",
      name: "音频 3",
      order: 4,
      muted: false,
      locked: false,
    });
  });

  it("round-trips track deletion through undo and redo", () => {
    const initial = createTestProject();
    addTrack(initial, "video-2", "video");
    const bus = new CommandBus(initial, { now: () => now });

    const applied = bus.execute({ type: "track.delete", trackId: "video-2" });

    expect(applied.tracks.map((track) => track.id)).toEqual([
      "video-1",
      "text-1",
    ]);
    expect(bus.undo()).toEqual(initial);
    expect(bus.redo()).toEqual(applied);
  });

  it("merges adjacent commands with the same transaction ID", () => {
    const bus = new CommandBus(createTestProject(), { now: () => now });

    bus.execute(
      { type: "clip.move", clipId: "clip-2", timelineStartUs: 7_000_000 },
      { transactionId: "drag-1" },
    );
    const final = bus.execute(
      { type: "clip.move", clipId: "clip-2", timelineStartUs: 8_000_000 },
      { transactionId: "drag-1" },
    );

    expect(final.revision).toBe(2);
    expect(bus.history()).toHaveLength(1);
    expect(bus.history()[0]?.commandTypes).toEqual(["clip.move", "clip.move"]);
    expect(bus.undo()).toEqual(createTestProject());
    expect(bus.redo()).toEqual(final);
  });

  it("records command transaction and revision metadata", () => {
    const events: CommandEvent[] = [];
    const bus = new CommandBus(createTestProject(), {
      now: () => now,
      onChange: (_project, event) => events.push(event),
    });

    bus.execute(
      { type: "clip.delete", clipId: "clip-1" },
      { transactionId: "delete-1" },
    );
    bus.undo();
    bus.redo();

    expect(events).toEqual([
      expect.objectContaining({
        action: "execute",
        transactionId: "delete-1",
        beforeRevision: 0,
        afterRevision: 1,
      }),
      expect.objectContaining({
        action: "undo",
        beforeRevision: 1,
        afterRevision: 0,
      }),
      expect.objectContaining({
        action: "redo",
        beforeRevision: 0,
        afterRevision: 1,
      }),
    ]);
  });

  it("clears redo history after a new command", () => {
    const bus = new CommandBus(createTestProject(), { now: () => now });
    bus.execute({ type: "clip.delete", clipId: "clip-1" });
    bus.undo();
    expect(bus.canRedo).toBe(true);

    bus.execute({
      type: "text.update",
      textId: "title-1",
      patch: { text: "另一条历史" },
    });

    expect(bus.canRedo).toBe(false);
  });

  it("does not commit or create history when a command violates invariants", () => {
    const initial = createTestProject();
    const bus = new CommandBus(initial, { now: () => now });

    expect(() =>
      bus.execute({
        type: "clip.split",
        clipId: "clip-1",
        rightClipId: "clip-right",
        timelineUs: 0,
      }),
    ).toThrow("分割时间必须位于片段内部");
    expect(bus.document).toEqual(initial);
    expect(bus.history()).toEqual([]);
    expect(bus.canUndo).toBe(false);
  });

  it("rejects duplicate entity IDs without mutating the source document", () => {
    const original = createTestProject();

    expect(() =>
      applyProjectCommand(
        original,
        {
          asset: { ...original.assets[0]! },
          type: "asset.add",
        },
        now,
      ),
    ).toThrow('素材 "asset-1" 已存在');
    expect(original).toEqual(createTestProject());
  });
});
