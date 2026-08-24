import {
  projectContentEndUs,
  type ProjectDocument,
} from "@web-video-editor/domain";

export const MIN_CLIP_DURATION_US = 100_000;
export const MIN_TIMELINE_DISPLAY_DURATION_US = 10_000_000;

export function clipDurationUs(clip: ProjectDocument["clips"][number]): number {
  return clip.sourceEndUs - clip.sourceStartUs;
}

export function projectDurationUs(project: ProjectDocument): number {
  return Math.max(
    MIN_TIMELINE_DISPLAY_DURATION_US,
    project.timeline.durationUs,
    projectContentEndUs(project),
  );
}

export function pixelsToTimeUs(
  pixels: number,
  pixelsPerSecond: number,
): number {
  return Math.round((pixels / pixelsPerSecond) * 1_000_000);
}

export function timeUsToPixels(
  timeUs: number,
  pixelsPerSecond: number,
): number {
  return (timeUs / 1_000_000) * pixelsPerSecond;
}

function clampStartBetweenSpans(
  spans: ReadonlyArray<{ endUs: number; startUs: number }>,
  durationUs: number,
  proposedStartUs: number,
): number {
  const proposed = Math.max(0, Math.round(proposedStartUs));
  const sorted = [...spans].sort((left, right) => left.startUs - right.startUs);
  let previousEndUs = 0;
  let bestStartUs = Math.max(0, proposed);
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const span of sorted) {
    const maximumStartUs = span.startUs - durationUs;
    if (maximumStartUs >= previousEndUs) {
      const candidateStartUs = Math.max(
        previousEndUs,
        Math.min(maximumStartUs, proposed),
      );
      const distance = Math.abs(candidateStartUs - proposed);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestStartUs = candidateStartUs;
      }
    }
    previousEndUs = Math.max(previousEndUs, span.endUs);
  }

  const candidateStartUs = Math.max(previousEndUs, proposed);
  const distance = Math.abs(candidateStartUs - proposed);
  if (distance < bestDistance) {
    bestStartUs = candidateStartUs;
  }

  return bestStartUs;
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
  targetTrackId?: string,
): number {
  const targetClip = project.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return 0;
  }
  const trackId = targetTrackId ?? targetClip.trackId;
  if (trackId !== targetClip.trackId) {
    return clampStartBetweenSpans(
      project.clips
        .filter((clip) => clip.trackId === trackId && clip.id !== clipId)
        .map((clip) => ({
          endUs: clip.timelineStartUs + clipDurationUs(clip),
          startUs: clip.timelineStartUs,
        })),
      clipDurationUs(targetClip),
      proposedStartUs,
    );
  }
  const sorted = project.clips
    .filter((clip) => clip.trackId === trackId)
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

export function clampTextMove(
  project: ProjectDocument,
  textId: string,
  proposedStartUs: number,
  targetTrackId?: string,
): number {
  const targetText = project.texts.find((text) => text.id === textId);
  if (!targetText) {
    return 0;
  }
  const trackId = targetTrackId ?? targetText.trackId;
  return clampStartBetweenSpans(
    project.texts
      .filter((text) => text.trackId === trackId && text.id !== textId)
      .map((text) => ({
        endUs: text.endUs,
        startUs: text.startUs,
      })),
    targetText.endUs - targetText.startUs,
    proposedStartUs,
  );
}
