import { describe, expect, it } from "vitest";
import type { VideoSample } from "mediabunny";
import {
  DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from "@web-video-editor/domain";
import {
  ProjectRuntimeAdapter,
  type RuntimeEntity,
} from "@web-video-editor/preview-runtime";

import {
  audibleAudioClips,
  canvasFilter,
  composeFrame,
  exportFrameCount,
  liveTimelineClips,
  mixPlanarAudioIntoChunks,
  normalizedAudioTimestampUs,
  type MixedAudioChunk,
} from "./export-pipeline";

class RecordingContext {
  filter = "none";
  fillStyle = "#000000";
  font = "";
  globalAlpha = 1;
  lineJoin: CanvasLineJoin = "miter";
  lineWidth = 1;
  strokeStyle = "#000000";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";

  private readonly stack: Array<{
    fillStyle: string;
    filter: string;
    font: string;
    globalAlpha: number;
    lineJoin: CanvasLineJoin;
    lineWidth: number;
    strokeStyle: string;
    textAlign: CanvasTextAlign;
    textBaseline: CanvasTextBaseline;
  }> = [];

  constructor(
    private readonly calls: string[],
    private readonly recordTransforms = false,
  ) {}

  fillRect(_x?: number, _y?: number, width?: number, height?: number): void {
    this.calls.push(
      `fillRect:fill=${this.fillStyle}:alpha=${this.globalAlpha}:w=${width}:h=${height}`,
    );
  }

  fillText(value: string): void {
    this.calls.push(
      `text:${value}:fill=${this.fillStyle}:font=${this.font}:alpha=${this.globalAlpha}`,
    );
  }

  measureText(value: string): TextMetrics {
    return {
      actualBoundingBoxAscent: 20,
      actualBoundingBoxDescent: 5,
      width: value.length * 10,
    } as TextMetrics;
  }

  restore(): void {
    const state = this.stack.pop();
    if (state) {
      this.fillStyle = state.fillStyle;
      this.filter = state.filter;
      this.font = state.font;
      this.globalAlpha = state.globalAlpha;
      this.lineJoin = state.lineJoin;
      this.lineWidth = state.lineWidth;
      this.strokeStyle = state.strokeStyle;
      this.textAlign = state.textAlign;
      this.textBaseline = state.textBaseline;
    }
  }

  rotate(angle: number): void {
    if (this.recordTransforms) {
      this.calls.push(`rotate:${angle}`);
    }
  }

  save(): void {
    this.stack.push({
      fillStyle: this.fillStyle,
      filter: this.filter,
      font: this.font,
      globalAlpha: this.globalAlpha,
      lineJoin: this.lineJoin,
      lineWidth: this.lineWidth,
      strokeStyle: this.strokeStyle,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    });
  }

  scale(x: number, y: number): void {
    if (this.recordTransforms) {
      this.calls.push(`scale:${x},${y}`);
    }
  }

  setTransform(): void {}

  strokeText(value: string): void {
    this.calls.push(
      `stroke:${value}:stroke=${this.strokeStyle}:width=${this.lineWidth}:font=${this.font}:alpha=${this.globalAlpha}`,
    );
  }

  translate(x: number, y: number): void {
    if (this.recordTransforms) {
      this.calls.push(`translate:${x},${y}`);
    }
  }
}

function videoEntity(
  id: string,
  order: number,
  opacity: number,
  effects: RuntimeEntity["effects"]["resolved"] = [],
): RuntimeEntity {
  return {
    animation: { opacity },
    effects: { definitions: [], resolved: effects },
    id,
    kind: "video",
    render: { order, visible: true },
    timeline: {
      active: true,
      endUs: 1_000_000,
      localTimeUs: 0,
      sourceStartUs: 0,
      startUs: 0,
    },
    transform: {
      height: 1080,
      rotationRad: 0,
      scaleX: 1,
      scaleY: 1,
      width: 1920,
      x: 960,
      y: 540,
    },
    video: { assetId: "asset-1", requestedSourceTimeUs: 0 },
  };
}

function textEntity(
  id: string,
  order: number,
  style: Partial<NonNullable<RuntimeEntity["text"]>> = {},
): RuntimeEntity {
  return {
    animation: { opacity: 0.8 },
    effects: { definitions: [], resolved: [] },
    id,
    kind: "text",
    render: { order, visible: true },
    text: {
      backgroundColor: "#000000",
      backgroundOpacity: 0,
      color: "#ff2d55",
      fontFamily: "Inter, sans-serif",
      fontSize: 92,
      strokeColor: "#000000",
      strokeWidth: 0,
      value: "TITLE",
      ...style,
    },
    timeline: {
      active: true,
      endUs: 1_000_000,
      localTimeUs: 0,
      sourceStartUs: 0,
      startUs: 0,
    },
    transform: {
      height: 0,
      rotationRad: 0,
      scaleX: 1,
      scaleY: 1,
      width: 0,
      x: 960,
      y: 180,
    },
  };
}

function videoSample(
  id: string,
  calls: string[],
  width = 1920,
  height = 1080,
): VideoSample {
  return {
    close: () => undefined,
    displayHeight: height,
    displayWidth: width,
    draw: (
      context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    ) => {
      const recording = context as unknown as RecordingContext;
      calls.push(
        `video:${id}:filter=${recording.filter}:alpha=${recording.globalAlpha}`,
      );
    },
  } as unknown as VideoSample;
}

function audioProject(): ProjectDocument {
  return {
    assets: [
      {
        durationUs: 10_000_000,
        fingerprint: "sha256:audio",
        frameRate: 30,
        hasAudio: true,
        height: 1080,
        id: "asset-audio",
        name: "audio.mp4",
        source: { kind: "test-asset", name: "audio.mp4", size: 1 },
        width: 1920,
      },
      {
        durationUs: 10_000_000,
        fingerprint: "sha256:silent",
        frameRate: 30,
        hasAudio: false,
        height: 1080,
        id: "asset-silent",
        name: "silent.mp4",
        source: { kind: "test-asset", name: "silent.mp4", size: 1 },
        width: 1920,
      },
    ],
    canvas: {
      backgroundColor: "#000000",
      height: 1080,
      width: 1920,
    },
    clips: [
      {
        assetId: "asset-audio",
        effects: [],
        id: "video-layer",
        sourceEndUs: 1_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "video-track",
      },
      {
        assetId: "asset-audio",
        effects: [],
        id: "audio-a",
        sourceEndUs: 2_000_000,
        sourceStartUs: 1_000_000,
        timelineStartUs: 0,
        trackId: "audio-track",
      },
      {
        assetId: "asset-audio",
        effects: [],
        id: "audio-b",
        sourceEndUs: 1_500_000,
        sourceStartUs: 500_000,
        timelineStartUs: 250_000,
        trackId: "audio-track-2",
      },
      {
        assetId: "asset-audio",
        effects: [],
        id: "audio-muted",
        sourceEndUs: 1_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "audio-muted-track",
      },
      {
        assetId: "asset-silent",
        effects: [],
        id: "audio-no-source-track",
        sourceEndUs: 1_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "audio-track",
      },
    ],
    createdAt: "2026-08-09T00:00:00.000Z",
    exportSettings: {
      audioBitrate: 192_000,
      audioCodec: "aac",
      frameRate: 30,
      height: 1080,
      videoBitrate: 8_000_000,
      videoCodec: "h264",
      width: 1920,
    },
    id: "project-audio",
    name: "Audio Export",
    revision: 0,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    texts: [],
    tracks: [
      {
        id: "video-track",
        kind: "video",
        locked: false,
        muted: false,
        name: "Video",
        order: 0,
      },
      {
        id: "audio-track",
        kind: "audio",
        locked: false,
        muted: false,
        name: "Audio 1",
        order: 1,
      },
      {
        id: "audio-track-2",
        kind: "audio",
        locked: false,
        muted: false,
        name: "Audio 2",
        order: 2,
      },
      {
        id: "audio-muted-track",
        kind: "audio",
        locked: false,
        muted: true,
        name: "Muted Audio",
        order: 3,
      },
    ],
    timeline: {
      durationUs: 2_000_000,
      defaultScale: {
        pixelsPerSecond: DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
      },
    },
    updatedAt: "2026-08-09T00:00:00.000Z",
  };
}

function expectSample(
  chunk: MixedAudioChunk,
  channel: number,
  frame: number,
  value: number,
): void {
  expect(chunk.data[channel * chunk.frames + frame]).toBeCloseTo(value, 5);
}

describe("export pipeline timing and shared effect mapping", () => {
  it("iterates the complete output timeline at the configured FPS", () => {
    expect(exportFrameCount(2_000_000, 30)).toBe(60);
    expect(exportFrameCount(2_010_000, 30)).toBe(61);
  });

  it("normalizes a trimmed source timestamp onto project time", () => {
    expect(normalizedAudioTimestampUs(2_000_000, 1_000_000, 1_250_000)).toBe(
      2_250_000,
    );
  });

  it("maps normalized ECS effects to the export canvas", () => {
    expect(
      canvasFilter([
        { amount: 0.75, id: "vintage", kind: "vintage" },
        {
          brightness: 0.2,
          contrast: 0.5,
          id: "adjust",
          kind: "adjustments",
        },
      ]),
    ).toContain("sepia(0.75)");
    expect(
      canvasFilter([
        {
          brightness: 0.2,
          contrast: 0.5,
          id: "adjust",
          kind: "adjustments",
        },
      ]),
    ).toBe("brightness(1.2) contrast(0.75)");
  });

  it("composes overlapping video entities by active entity order", () => {
    const calls: string[] = [];
    const context = new RecordingContext(calls);
    const lower = videoEntity("clip:lower", 0, 1);
    const title = textEntity("text:title", 1);
    const upper = videoEntity("clip:upper", 2, 0.5, [
      { amount: 1, id: "grayscale", kind: "grayscale" },
    ]);

    composeFrame(
      { height: 1080, width: 1920 } as OffscreenCanvas,
      context as unknown as OffscreenCanvasRenderingContext2D,
      "#000000",
      [lower, title, upper],
      new Map([
        ["clip:lower", videoSample("lower", calls)],
        ["clip:upper", videoSample("upper", calls)],
      ]),
    );

    expect(calls).toEqual([
      "fillRect:fill=#000000:alpha=1:w=1920:h=1080",
      "video:lower:filter=none:alpha=1",
      "text:TITLE:fill=#ff2d55:font=700 92px Inter, sans-serif:alpha=0.8",
      "video:upper:filter=grayscale(1):alpha=0.5",
    ]);
  });

  it("composes styled text background, stroke, font, and transform", () => {
    const calls: string[] = [];
    const context = new RecordingContext(calls, true);
    const title = textEntity("text:styled", 1, {
      backgroundColor: "#102030",
      backgroundOpacity: 0.5,
      color: "#abcdef",
      fontFamily: '"Display Font", serif',
      fontSize: 50,
      strokeColor: "#010203",
      strokeWidth: 4,
      value: "Styled",
    });
    title.animation.opacity = 0.8;
    title.transform.rotationRad = Math.PI / 8;
    title.transform.scaleX = 1.2;
    title.transform.scaleY = 1.2;

    composeFrame(
      { height: 1080, width: 1920 } as OffscreenCanvas,
      context as unknown as OffscreenCanvasRenderingContext2D,
      "#000000",
      [title],
      new Map(),
    );

    expect(calls).toEqual([
      "fillRect:fill=#000000:alpha=1:w=1920:h=1080",
      "translate:960,180",
      `rotate:${Math.PI / 8}`,
      "scale:1.2,1.2",
      "fillRect:fill=#102030:alpha=0.4:w=95:h=47",
      'stroke:Styled:stroke=#010203:width=4:font=700 50px "Display Font", serif:alpha=0.8',
      'text:Styled:fill=#abcdef:font=700 50px "Display Font", serif:alpha=0.8',
    ]);
    expect(context.font).toBe("");
    expect(context.globalAlpha).toBe(1);
  });

  it("composes export text entities by runtime time range and track order", () => {
    const document = audioProject();
    document.clips = [];
    document.tracks = [
      {
        id: "text-high",
        kind: "text",
        locked: false,
        muted: false,
        name: "T2",
        order: 6,
      },
      {
        id: "text-low",
        kind: "text",
        locked: false,
        muted: false,
        name: "T1",
        order: 2,
      },
    ];
    document.texts = [
      {
        backgroundColor: "#000000",
        backgroundOpacity: 0,
        color: "#ffffff",
        endUs: 3_000_000,
        fontFamily: "Inter, sans-serif",
        fontSize: 44,
        id: "lower",
        rotationDeg: 0,
        scale: 1,
        startUs: 1_000_000,
        strokeColor: "#000000",
        strokeWidth: 0,
        text: "Lower",
        trackId: "text-low",
        x: 0.5,
        y: 0.5,
      },
      {
        backgroundColor: "#000000",
        backgroundOpacity: 0,
        color: "#ffffff",
        endUs: 4_000_000,
        fontFamily: "Inter, sans-serif",
        fontSize: 44,
        id: "upper",
        rotationDeg: 0,
        scale: 1,
        startUs: 2_000_000,
        strokeColor: "#000000",
        strokeWidth: 0,
        text: "Upper",
        trackId: "text-high",
        x: 0.5,
        y: 0.5,
      },
    ];
    const adapter = new ProjectRuntimeAdapter({ quality: "export" });

    const beforeCalls: string[] = [];
    composeFrame(
      { height: 1080, width: 1920 } as OffscreenCanvas,
      new RecordingContext(
        beforeCalls,
      ) as unknown as OffscreenCanvasRenderingContext2D,
      "#000000",
      adapter.evaluate(document, 999_999).activeEntities,
      new Map(),
    );
    expect(beforeCalls).toEqual([
      "fillRect:fill=#000000:alpha=1:w=1920:h=1080",
    ]);

    const overlappingCalls: string[] = [];
    composeFrame(
      { height: 1080, width: 1920 } as OffscreenCanvas,
      new RecordingContext(
        overlappingCalls,
      ) as unknown as OffscreenCanvasRenderingContext2D,
      "#000000",
      adapter.evaluate(document, 2_500_000).activeEntities,
      new Map(),
    );
    expect(overlappingCalls).toEqual([
      "fillRect:fill=#000000:alpha=1:w=1920:h=1080",
      "text:Lower:fill=#ffffff:font=700 44px Inter, sans-serif:alpha=1",
      "text:Upper:fill=#ffffff:font=700 44px Inter, sans-serif:alpha=1",
    ]);

    const afterLowerCalls: string[] = [];
    composeFrame(
      { height: 1080, width: 1920 } as OffscreenCanvas,
      new RecordingContext(
        afterLowerCalls,
      ) as unknown as OffscreenCanvasRenderingContext2D,
      "#000000",
      adapter.evaluate(document, 3_000_000).activeEntities,
      new Map(),
    );
    expect(afterLowerCalls).toEqual([
      "fillRect:fill=#000000:alpha=1:w=1920:h=1080",
      "text:Upper:fill=#ffffff:font=700 44px Inter, sans-serif:alpha=1",
    ]);
  });

  it("selects only unmuted audio-track clips for export audio", () => {
    expect(audibleAudioClips(audioProject()).map((clip) => clip.id)).toEqual([
      "audio-a",
      "audio-b",
    ]);
  });

  it("ignores clips left on deleted tracks before export source and audio selection", () => {
    const project = audioProject();
    project.assets.push({
      durationUs: 10_000_000,
      fingerprint: "sha256:deleted",
      frameRate: 30,
      hasAudio: true,
      height: 1080,
      id: "asset-deleted",
      name: "deleted.mp4",
      source: { kind: "test-asset", name: "deleted.mp4", size: 1 },
      width: 1920,
    });
    project.clips.push(
      {
        assetId: "asset-deleted",
        effects: [],
        id: "video-deleted-track",
        sourceEndUs: 1_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "deleted-video-track",
      },
      {
        assetId: "asset-deleted",
        effects: [],
        id: "audio-deleted-track",
        sourceEndUs: 1_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "deleted-audio-track",
      },
    );
    project.tracks = project.tracks.filter(
      (track) => track.id !== "audio-track-2",
    );

    expect(liveTimelineClips(project).map((clip) => clip.id)).toEqual([
      "video-layer",
      "audio-a",
      "audio-muted",
      "audio-no-source-track",
    ]);
    expect(audibleAudioClips(project).map((clip) => clip.id)).toEqual([
      "audio-a",
    ]);
  });

  it("mixes multiple audio clips into the same project-time chunk", () => {
    const chunks = new Map<number, MixedAudioChunk>();
    const secondFrameUs = normalizedAudioTimestampUs(
      0,
      1_000_000,
      1_000_000 + Math.round((2 * 1_000_000) / 48_000),
    );

    mixPlanarAudioIntoChunks(
      chunks,
      {
        channelData: [
          Float32Array.of(0.1, 0.2, 0.3, 0.4),
          Float32Array.of(0.2, 0.2, 0.2, 0.2),
        ],
        numberOfFrames: 4,
        sampleRate: 48_000,
        timelineStartUs: 0,
      },
      200_000,
    );
    mixPlanarAudioIntoChunks(
      chunks,
      {
        channelData: [Float32Array.of(0.5, 0.5, 0.5, 0.5)],
        numberOfFrames: 4,
        sampleRate: 48_000,
        timelineStartUs: secondFrameUs,
      },
      200_000,
    );

    const chunk = chunks.get(0);
    expect(chunk).toBeDefined();
    expectSample(chunk!, 0, 0, 0.1);
    expectSample(chunk!, 0, 1, 0.2);
    expectSample(chunk!, 0, 2, 0.8);
    expectSample(chunk!, 0, 3, 0.9);
    expectSample(chunk!, 0, 4, 0.5);
    expectSample(chunk!, 1, 2, 0.7);
    expectSample(chunk!, 1, 4, 0.5);
  });
});
