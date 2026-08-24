import { describe, expect, it } from "vitest";
import type { VideoSample } from "mediabunny";
import type { ProjectDocument } from "@web-video-editor/domain";
import type { RuntimeEntity } from "@web-video-editor/preview-runtime";

import {
  audibleAudioClips,
  canvasFilter,
  composeFrame,
  exportFrameCount,
  mixPlanarAudioIntoChunks,
  normalizedAudioTimestampUs,
  type MixedAudioChunk,
} from "./export-pipeline";

class RecordingContext {
  filter = "none";
  fillStyle = "#000000";
  font = "";
  globalAlpha = 1;
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";

  private readonly stack: Array<{ filter: string; globalAlpha: number }> = [];

  constructor(private readonly calls: string[]) {}

  fillRect(): void {
    this.calls.push("fillRect");
  }

  fillText(value: string): void {
    this.calls.push(`text:${value}:alpha=${this.globalAlpha}`);
  }

  restore(): void {
    const state = this.stack.pop();
    if (state) {
      this.filter = state.filter;
      this.globalAlpha = state.globalAlpha;
    }
  }

  rotate(): void {}

  save(): void {
    this.stack.push({
      filter: this.filter,
      globalAlpha: this.globalAlpha,
    });
  }

  scale(): void {}

  setTransform(): void {}

  translate(): void {}
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

function textEntity(id: string, order: number): RuntimeEntity {
  return {
    animation: { opacity: 0.8 },
    effects: { definitions: [], resolved: [] },
    id,
    kind: "text",
    render: { order, visible: true },
    text: {
      color: "#ff2d55",
      fontSize: 92,
      value: "TITLE",
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
    schemaVersion: 1,
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
      "fillRect",
      "video:lower:filter=none:alpha=1",
      "text:TITLE:alpha=0.8",
      "video:upper:filter=grayscale(1):alpha=0.5",
    ]);
  });

  it("selects only unmuted audio-track clips for export audio", () => {
    expect(audibleAudioClips(audioProject()).map((clip) => clip.id)).toEqual([
      "audio-a",
      "audio-b",
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
