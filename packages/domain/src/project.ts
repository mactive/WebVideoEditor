import { PROJECT_SCHEMA_VERSION, type ProjectDocument } from "./schema";

export type CreateProjectOptions = {
  id: string;
  name: string;
  now?: string;
};

export function createProjectDocument({
  id,
  name,
  now = new Date().toISOString(),
}: CreateProjectOptions): ProjectDocument {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    name,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    assets: [],
    tracks: [
      {
        id: "video-track",
        kind: "video",
        name: "视频",
        order: 0,
        muted: false,
        locked: false,
      },
      {
        id: "audio-track",
        kind: "audio",
        name: "音频",
        order: 1,
        muted: false,
        locked: false,
      },
      {
        id: "text-track",
        kind: "text",
        name: "文字",
        order: 2,
        muted: false,
        locked: false,
      },
    ],
    clips: [],
    texts: [],
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
  };
}
