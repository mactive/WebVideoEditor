import {
  DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from "@web-video-editor/domain";
import {
  createMediabunnyDecoderQueueObservation,
  type AudioPlaybackRequest,
  type MediabunnyAudioPlayback,
} from "@web-video-editor/media-runtime";
import { describe, expect, it, vi } from "vitest";

import type { PreviewDecoderClient } from "./decoder";
import type { PixiPreviewRenderer } from "./pixi-renderer";
import { PreviewRuntime } from "./preview-runtime";
import { resolveEffects, resolveQualityProfile } from "./quality";
import { ProjectRuntimeAdapter } from "./runtime-adapter";
import { PREVIEW_SYSTEM_ORDER } from "./systems";
import type { PreviewSource, RuntimeEntity } from "./types";

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
    timeline: {
      durationUs: 7_000_000,
      defaultScale: {
        pixelsPerSecond: DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
      },
    },
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
      activeVideos: [
        {
          assetId: "asset-1",
          entityId: "clip:clip-1",
          sourceTimeUs: 1_500_000,
        },
      ],
      created: 2,
      released: 0,
      updated: 0,
    });
    expect(rendered.map((entity) => entity.kind)).toEqual(["video", "text"]);
    expect(rendered[0]?.effects.resolved).toEqual([
      { amount: 0.8, id: "gray", kind: "grayscale" },
    ]);

    const second = adapter.evaluate(project(), 5_500_000);
    expect(second.created).toBe(0);
    expect(second.activeEntities).toHaveLength(1);
    expect(second.activeVideos[0]?.sourceTimeUs).toBe(4_500_000);
  });

  it("evaluates all active video entities in render order and syncs them to the render target", () => {
    let rendered: readonly RuntimeEntity[] = [];
    const adapter = new ProjectRuntimeAdapter({
      renderTarget: {
        sync(entities) {
          rendered = entities;
        },
      },
    });
    const document: ProjectDocument = {
      ...project(),
      clips: [
        {
          assetId: "asset-1",
          effects: [
            {
              amount: 1,
              enabled: true,
              id: "overlay-gray",
              kind: "grayscale",
            },
          ],
          id: "clip-overlay",
          sourceEndUs: 4_000_000,
          sourceStartUs: 1_000_000,
          timelineStartUs: 1_000_000,
          trackId: "video-overlay",
          transform: {
            rotationDeg: 18,
            scale: 0.58,
            x: 0.68,
            y: 0.62,
          },
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "clip-base",
          sourceEndUs: 5_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "video-base",
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "clip-audio",
          sourceEndUs: 5_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "audio",
        },
      ],
      tracks: [
        {
          id: "video-overlay",
          kind: "video",
          locked: false,
          muted: true,
          name: "V2",
          order: 2,
        },
        {
          id: "video-base",
          kind: "video",
          locked: false,
          muted: false,
          name: "V1",
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
        {
          id: "audio",
          kind: "audio",
          locked: false,
          muted: false,
          name: "A1",
          order: 3,
        },
      ],
    };

    const result = adapter.evaluate(document, 2_500_000);

    expect(result.activeVideos).toEqual([
      {
        assetId: "asset-1",
        entityId: "clip:clip-base",
        order: 0,
        sourceTimeUs: 2_500_000,
      },
      {
        assetId: "asset-1",
        entityId: "clip:clip-overlay",
        order: 2,
        sourceTimeUs: 2_500_000,
      },
    ]);
    expect(result.activeEntities.map((entity) => entity.id)).toEqual([
      "clip:clip-base",
      "text:title",
      "clip:clip-overlay",
    ]);
    expect(rendered.map((entity) => entity.id)).toEqual([
      "clip:clip-base",
      "text:title",
      "clip:clip-overlay",
    ]);
    expect(rendered.map((entity) => entity.render.visible)).toEqual([
      true,
      true,
      true,
    ]);
    expect(rendered[2]?.effects.resolved).toEqual([
      { amount: 1, id: "overlay-gray", kind: "grayscale" },
    ]);
    expect(rendered[2]?.transform).toMatchObject({
      rotationRad: (18 * Math.PI) / 180,
      scaleX: 0.58,
      scaleY: 0.58,
      x: 652.8000000000001,
      y: 334.8,
    });
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

  it("does not keep entities whose tracks were deleted", () => {
    const adapter = new ProjectRuntimeAdapter();
    const initial = project();
    adapter.evaluate(initial, 2_500_000);

    const revised: ProjectDocument = {
      ...initial,
      clips: [
        ...initial.clips,
        {
          assetId: "asset-1",
          effects: [],
          id: "deleted-video",
          sourceEndUs: 3_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "deleted-video-track",
        },
      ],
      revision: 2,
      tracks: initial.tracks.filter((track) => track.id !== "text"),
    };

    const result = adapter.evaluate(revised, 2_500_000);

    expect(result).toMatchObject({
      created: 0,
      released: 1,
      updated: 1,
    });
    expect(result.activeEntities.map((entity) => entity.id)).toEqual([
      "clip:clip-1",
    ]);
    expect([...adapter.world].map((entity) => entity.id)).toEqual([
      "clip:clip-1",
    ]);
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

    expect(result.activeVideos[0]).toMatchObject({
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

describe("PreviewRuntime multi-layer scheduling", () => {
  it("uses the configured project timeline duration for transport bounds", () => {
    const document: ProjectDocument = {
      ...project(),
      clips: [],
      texts: [],
      timeline: {
        ...project().timeline,
        durationUs: 120_000_000,
      },
    };
    const decoderQueue =
      createMediabunnyDecoderQueueObservation("VideoDecoder");
    const decoder = {
      activeResources: () => 0,
      dispose: vi.fn(),
      resourceSnapshot: () => ({
        activeTotal: 0,
        byType: {},
        leaked: [],
      }),
      stats: () => ({
        decodeQueue: 0,
        decoderQueue,
        droppedFrames: 0,
        staleFrames: 0,
      }),
      subscribeStats: () => () => undefined,
    } as unknown as PreviewDecoderClient;
    const renderer = {
      destroy: vi.fn(),
      present: vi.fn(),
      sync: vi.fn(),
    } as unknown as PixiPreviewRenderer;

    const runtime = new PreviewRuntime({
      decoder,
      project: document,
      renderer,
      sources: [],
    });

    expect(runtime.getSnapshot().durationUs).toBe(120_000_000);
    runtime.seek(90_000_000);
    expect(runtime.getSnapshot().metrics.playheadUs).toBe(90_000_000);

    runtime.dispose();
  });

  it("requests and presents a decoded frame for every active video entity", async () => {
    const document: ProjectDocument = {
      ...project(),
      clips: [
        {
          assetId: "asset-1",
          effects: [],
          id: "base",
          sourceEndUs: 5_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "video-base",
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "overlay",
          sourceEndUs: 5_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "video-overlay",
        },
      ],
      texts: [],
      tracks: [
        {
          id: "video-base",
          kind: "video",
          locked: false,
          muted: false,
          name: "V1",
          order: 0,
        },
        {
          id: "video-overlay",
          kind: "video",
          locked: false,
          muted: false,
          name: "V2",
          order: 1,
        },
      ],
    };
    const source: PreviewSource = {
      assetId: "asset-1",
      cacheKey: "asset-1-cache",
      cacheStatus: "hit",
      frameRate: 30,
      height: 540,
      keyframes: [],
      mediaUrl: "blob:asset-1",
      width: 960,
    };
    const decoderQueue =
      createMediabunnyDecoderQueueObservation("VideoDecoder");
    const decode = vi.fn(
      (
        _source: PreviewSource,
        sourceTimeUs: number,
        projectRevision: number,
        requestId: string,
        entityId: string,
        generation: number,
      ) =>
        Promise.resolve({
          decodeFromUs: sourceTimeUs,
          entityId,
          frame: { timestamp: sourceTimeUs } as VideoFrame,
          generation,
          release: vi.fn(),
          requestId,
          requestedSourceTimeUs: sourceTimeUs,
          sourceTimeUs,
        }),
    );
    const decoder = {
      activeResources: () => 0,
      decode,
      dispose: vi.fn(),
      resourceSnapshot: () => ({
        activeTotal: 0,
        byType: {},
        leaked: [],
      }),
      stats: () => ({
        decodeQueue: 0,
        decoderQueue,
        droppedFrames: 0,
        staleFrames: 0,
      }),
      subscribeStats: () => () => undefined,
    } as unknown as PreviewDecoderClient;
    const renderer = {
      destroy: vi.fn(),
      present: vi.fn(),
      sync: vi.fn(),
    } as unknown as PixiPreviewRenderer;

    const runtime = new PreviewRuntime({
      decoder,
      project: document,
      renderer,
      sources: [source],
    });

    await vi.waitFor(() => {
      expect(decode).toHaveBeenCalledTimes(2);
      expect(renderer.present).toHaveBeenCalledTimes(2);
    });
    expect(decode.mock.calls.map((call) => call[4])).toEqual([
      "clip:base",
      "clip:overlay",
    ]);
    expect(
      vi.mocked(renderer.present).mock.calls.map((call) => call[1].entityId),
    ).toEqual(["clip:base", "clip:overlay"]);
    expect(runtime.getSnapshot().metrics.activeVideoLayers).toBe(2);

    runtime.dispose();
  });

  it("plays only unmuted audio-track clips while keeping muted video tracks visible", async () => {
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const document: ProjectDocument = {
      ...project(),
      clips: [
        {
          assetId: "asset-1",
          effects: [],
          id: "video-muted",
          sourceEndUs: 5_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          trackId: "video-muted",
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "audio-live",
          sourceEndUs: 5_000_000,
          sourceStartUs: 1_000_000,
          timelineStartUs: 0,
          trackId: "audio-live",
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "audio-muted",
          sourceEndUs: 5_000_000,
          sourceStartUs: 2_000_000,
          timelineStartUs: 0,
          trackId: "audio-muted",
        },
        {
          assetId: "asset-1",
          effects: [],
          id: "audio-deleted-track",
          sourceEndUs: 5_000_000,
          sourceStartUs: 3_000_000,
          timelineStartUs: 0,
          trackId: "audio-deleted",
        },
      ],
      texts: [],
      tracks: [
        {
          id: "video-muted",
          kind: "video",
          locked: false,
          muted: true,
          name: "V1",
          order: 0,
        },
        {
          id: "audio-live",
          kind: "audio",
          locked: false,
          muted: false,
          name: "A1",
          order: 1,
        },
        {
          id: "audio-muted",
          kind: "audio",
          locked: false,
          muted: true,
          name: "A2",
          order: 2,
        },
      ],
    };
    const source: PreviewSource = {
      assetId: "asset-1",
      cacheKey: "asset-1-cache",
      cacheStatus: "hit",
      frameRate: 30,
      height: 540,
      keyframes: [],
      mediaUrl: "blob:asset-1",
      width: 960,
    };
    const decoderQueue =
      createMediabunnyDecoderQueueObservation("VideoDecoder");
    const decode = vi.fn(
      (
        _source: PreviewSource,
        sourceTimeUs: number,
        projectRevision: number,
        requestId: string,
        entityId: string,
        generation: number,
      ) =>
        Promise.resolve({
          decodeFromUs: sourceTimeUs,
          entityId,
          frame: { timestamp: sourceTimeUs } as VideoFrame,
          generation,
          release: vi.fn(),
          requestId,
          requestedSourceTimeUs: sourceTimeUs,
          sourceTimeUs,
        }),
    );
    const decoder = {
      activeResources: () => 0,
      decode,
      dispose: vi.fn(),
      resourceSnapshot: () => ({
        activeTotal: 0,
        byType: {},
        leaked: [],
      }),
      stats: () => ({
        decodeQueue: 0,
        decoderQueue,
        droppedFrames: 0,
        staleFrames: 0,
      }),
      subscribeStats: () => () => undefined,
    } as unknown as PreviewDecoderClient;
    const renderer = {
      destroy: vi.fn(),
      present: vi.fn(),
      sync: vi.fn(),
    } as unknown as PixiPreviewRenderer;
    const audioDecoderQueue =
      createMediabunnyDecoderQueueObservation("AudioDecoder");
    const audio = {
      dispose: vi.fn(),
      setSources: vi.fn(),
      start: vi.fn(async (request: AudioPlaybackRequest) => ({
        generation: 1,
        hasAudio: request.clips.length > 0,
        nowSeconds: () => 10,
        startedAtSeconds: 10,
      })),
      stats: vi.fn(() => ({
        activeGenerations: [1],
        activeSources: 1,
        decoderQueue: audioDecoderQueue,
        decodedBuffers: 1,
        generation: 1,
        projectRevision: document.revision,
        scheduledBuffers: 1,
        staleBuffers: 0,
        stoppedSources: 0,
      })),
      stop: vi.fn(),
    } as unknown as MediabunnyAudioPlayback;

    const runtime = new PreviewRuntime({
      audio,
      decoder,
      project: document,
      renderer,
      sources: [source],
    });

    try {
      await vi.waitFor(() => {
        expect(decode).toHaveBeenCalledWith(
          source,
          0,
          document.revision,
          expect.any(String),
          "clip:video-muted",
          expect.any(Number),
          expect.any(AbortSignal),
        );
      });
      expect(runtime.getSnapshot().metrics.activeVideoLayers).toBe(1);

      runtime.play();

      await vi.waitFor(() => expect(audio.start).toHaveBeenCalledOnce());
      expect(vi.mocked(audio.start).mock.calls[0]?.[0].clips).toEqual([
        {
          assetId: "asset-1",
          id: "audio-live",
          sourceEndUs: 5_000_000,
          sourceStartUs: 1_000_000,
          timelineStartUs: 0,
        },
      ]);
      await vi.waitFor(() =>
        expect(runtime.getSnapshot().metrics.audioActiveSources).toBe(1),
      );
    } finally {
      runtime.dispose();
      vi.unstubAllGlobals();
    }
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
