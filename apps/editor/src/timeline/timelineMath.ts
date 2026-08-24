import type { ProjectDocument } from "@web-video-editor/domain";

export const MIN_CLIP_DURATION_US = 100_000;

export function clipDurationUs(clip: ProjectDocument["clips"][number]): number {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function projectDurationUs(project: ProjectDocument): number {
  const clipEnd = project.clips.reduce(
    (maximum, clip) =>
      Math.max(maximum, clip.timelineStartUs + clipDurationUs(clip)),
    0,
  );
  const textEnd = project.texts.reduce(
    (maximum, text) => Math.max(maximum, text.endUs),
    0,
  );
  return Math.max(1_000_000, clipEnd, textEnd);
}

export function appendTimelineStartUs(
  project: ProjectDocument,
  trackId?: string,
): number {
  return project.clips
    .filter((clip) => !trackId || clip.trackId === trackId)
    .reduce(
      (maximum, clip) =>
        Math.max(maximum, clip.timelineStartUs + clipDurationUs(clip)),
      0,
    );
}

export function clampClipMove(
  project: ProjectDocument,
  clipId: string,
  proposedStartUs: number,
): number {
  const targetClip = project.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return 0;
  }
  const sorted = project.clips
    .filter((clip) => clip.trackId === targetClip.trackId)
    .sort((left, right) => left.timelineStartUs - right.timelineStartUs);
  const index = sorted.findIndex((clip) => clip.id === clipId);
  const clip = sorted[index];
  if (!clip) {
    return 0;
  }
  const previous = sorted[index - 1];
  const next = sorted[index + 1];
  const minimum = previous
    ? previous.timelineStartUs + clipDurationUs(previous)
    : 0;
  const maximum = next
    ? next.timelineStartUs - clipDurationUs(clip)
    : Number.MAX_SAFE_INTEGER;
  return Math.max(minimum, Math.min(maximum, Math.round(proposedStartUs)));
}
