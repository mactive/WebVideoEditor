import type { ProjectDocument } from "./schema";

export function createTestProject(): ProjectDocument {
  return {
    schemaVersion: 2,
    id: "project-1",
    name: "测试工程",
    revision: 0,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    assets: [
      {
        id: "asset-1",
        name: "test.mp4",
        fingerprint: "sha256:test",
        durationUs: 20_000_000,
        width: 1920,
        height: 1080,
        frameRate: 30,
        hasAudio: true,
        source: {
          kind: "test-asset",
          name: "test.mp4",
          size: 1024,
        },
      },
    ],
    tracks: [
      {
        id: "video-1",
        kind: "video",
        name: "视频",
        order: 0,
        muted: false,
        locked: false,
      },
      {
        id: "text-1",
        kind: "text",
        name: "文字",
        order: 1,
        muted: false,
        locked: false,
      },
    ],
    clips: [
      {
        id: "clip-1",
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 0,
        sourceStartUs: 0,
        sourceEndUs: 5_000_000,
        effects: [],
      },
      {
        id: "clip-2",
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 6_000_000,
        sourceStartUs: 5_000_000,
        sourceEndUs: 10_000_000,
        effects: [],
      },
    ],
    texts: [
      {
        id: "title-1",
        trackId: "text-1",
        text: "标题",
        startUs: 0,
        endUs: 3_000_000,
        fontSize: 48,
        color: "#ffffff",
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotationDeg: 0,
      },
    ],
    canvas: {
      width: 1920,
      height: 1080,
      backgroundColor: "#000000",
    },
    exportSettings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      videoCodec: "h264",
      audioCodec: "aac",
      videoBitrate: 8_000_000,
      audioBitrate: 192_000,
    },
    timeline: {
      durationUs: 11_000_000,
      defaultScale: {
        pixelsPerSecond: 80,
      },
    },
  };
}
