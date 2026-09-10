import {
  DEFAULT_TIMELINE_DURATION_US,
  DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
} from "./schema";

export const MIN_CLIP_DURATION_US = 100_000;
export const MIN_TEXT_DURATION_US = 100_000;

export type CreateProjectOptions = {
  id: string;
  name: string;
  now?: string;
};

export function clipDurationUs(clip: ProjectDocument["clips"][number]): number {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function textDurationUs(text: ProjectDocument["texts"][number]): number {
  return text.endUs - text.startUs;
}

export function projectContentEndUs(
  project: Pick<ProjectDocument, "clips" | "texts">,
): number {
  const clipEnd = project.clips.reduce(
    (maximum, clip) =>
      Math.max(maximum, clip.timelineStartUs + clipDurationUs(clip)),
    0,
  );
  const textEnd = project.texts.reduce(
    (maximum, text) => Math.max(maximum, text.endUs),
    0,
  );
  return Math.max(clipEnd, textEnd);
}

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
    timeline: {
      durationUs: DEFAULT_TIMELINE_DURATION_US,
      defaultScale: {
        pixelsPerSecond: DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
      },
    },
  };
}
