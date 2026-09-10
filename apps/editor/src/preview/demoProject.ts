import {
  DEFAULT_TEXT_BACKGROUND_COLOR,
  DEFAULT_TEXT_BACKGROUND_OPACITY,
  DEFAULT_TEXT_FONT_FAMILY,
  DEFAULT_TEXT_STROKE_COLOR,
  DEFAULT_TEXT_STROKE_WIDTH,
  DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from "@web-video-editor/domain";
import type { ProxyManifest } from "@web-video-editor/media-runtime";
import type { PreviewSource } from "@web-video-editor/preview-runtime";

export function createPreviewDemo(manifest: ProxyManifest): {
  project: ProjectDocument;
  sources: PreviewSource[];
} {
  const durationUs = Math.round(manifest.proxy.durationSec * 1_000_000);
  const assetId = `asset-${manifest.fingerprint}`;
  const now = new Date().toISOString();
  const project: ProjectDocument = {
    assets: [
      {
        durationUs,
        fingerprint: manifest.fingerprint,
        frameRate: manifest.proxy.frameRate,
        hasAudio: true,
        height: manifest.source.height,
        id: assetId,
        name: "test_1.mp4",
        source: {
          kind: "test-asset",
          name: "test_1.mp4",
          size: manifest.proxy.byteLength,
        },
        width: manifest.source.width,
      },
    ],
    canvas: {
      backgroundColor: "#090b10",
      height: 720,
      width: 720,
    },
    clips: [
      {
        assetId,
        effects: [
          {
            amount: 0.22,
            enabled: true,
            id: "preview-grayscale",
            kind: "grayscale",
          },
          {
            amount: 0.28,
            enabled: true,
            id: "preview-vintage",
            kind: "vintage",
          },
          {
            brightness: 0.06,
            contrast: 0.12,
            enabled: true,
            id: "preview-adjustments",
            kind: "adjustments",
          },
        ],
        id: "test-1-clip",
        sourceEndUs: durationUs,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "video-track",
      },
    ],
    createdAt: now,
    exportSettings: {
      audioBitrate: 192_000,
      audioCodec: "aac",
      frameRate: manifest.proxy.frameRate,
      height: 720,
      videoBitrate: 8_000_000,
      videoCodec: "h264",
      width: 720,
    },
    id: "task-8-preview",
    name: "Task 8 test_1 真实代理预览",
    revision: 1,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    texts: [
      {
        backgroundColor: DEFAULT_TEXT_BACKGROUND_COLOR,
        backgroundOpacity: DEFAULT_TEXT_BACKGROUND_OPACITY,
        color: "#ffffff",
        endUs: durationUs,
        fontFamily: DEFAULT_TEXT_FONT_FAMILY,
        fontSize: 46,
        id: "preview-title",
        rotationDeg: -2,
        scale: 1,
        startUs: 0,
        strokeColor: DEFAULT_TEXT_STROKE_COLOR,
        strokeWidth: DEFAULT_TEXT_STROKE_WIDTH,
        text: "TASK 8 · REAL PROXY",
        trackId: "text-track",
        x: 0.5,
        y: 0.12,
      },
    ],
    tracks: [
      {
        id: "video-track",
        kind: "video",
        locked: false,
        muted: false,
        name: "视频",
        order: 0,
      },
      {
        id: "text-track",
        kind: "text",
        locked: false,
        muted: false,
        name: "文字",
        order: 1,
      },
    ],
    timeline: {
      durationUs,
      defaultScale: {
        pixelsPerSecond: DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
      },
    },
    updatedAt: now,
  };
  return {
    project,
    sources: [
      {
        assetId,
        cacheStatus: "hit",
        keyframes: manifest.keyframes,
        manifest,
      },
    ],
  };
}
