import {
  createProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";
import { describe, expect, it } from "vitest";

import {
  appendTimelineStartUs,
  clampClipMove,
  projectDurationUs,
} from "./timelineMath";

function projectWithClips(): ProjectDocument {
  const project = createProjectDocument({
    id: "timeline-test",
    name: "Timeline test",
    now: "2026-08-09T00:00:00.000Z",
  });
  project.assets.push({
    durationUs: 20_000_000,
    fingerprint: "asset",
    frameRate: 30,
    hasAudio: true,
    height: 720,
    id: "asset",
    name: "test.mp4",
    source: { kind: "test-asset", name: "test.mp4", size: 100 },
    width: 1280,
  });
  project.clips.push(
    {
      assetId: "asset",
      effects: [],
      id: "clip-1",
      sourceEndUs: 5_000_000,
      sourceStartUs: 0,
      timelineStartUs: 0,
      trackId: "video-track",
    },
    {
      assetId: "asset",
      effects: [],
      id: "clip-2",
      sourceEndUs: 4_000_000,
      sourceStartUs: 0,
      timelineStartUs: 7_000_000,
      trackId: "video-track",
    },
  );
  return project;
}

describe("timeline math", () => {
  it("derives duration and append position from Project clips", () => {
    const project = projectWithClips();

    expect(projectDurationUs(project)).toBe(11_000_000);
    expect(appendTimelineStartUs(project)).toBe(11_000_000);
  });

  it("clamps movement between adjacent clips without overlap", () => {
    const project = projectWithClips();

    expect(clampClipMove(project, "clip-2", 3_000_000)).toBe(5_000_000);
    expect(clampClipMove(project, "clip-1", 4_000_000)).toBe(2_000_000);
  });

  it("calculates append and movement boundaries within the clip track", () => {
    const project = projectWithClips();
    project.tracks.push({
      id: "video-track-2",
      kind: "video",
      name: "视频 2",
      order: 3,
      muted: false,
      locked: false,
    });
    expect(appendTimelineStartUs(project, "video-track-2")).toBe(0);
    project.clips.push({
      assetId: "asset",
      effects: [],
      id: "clip-3",
      sourceEndUs: 1_000_000,
      sourceStartUs: 0,
      timelineStartUs: 5_500_000,
      trackId: "video-track-2",
    });

    expect(appendTimelineStartUs(project, "video-track")).toBe(11_000_000);
    expect(appendTimelineStartUs(project, "video-track-2")).toBe(6_500_000);
    expect(clampClipMove(project, "clip-3", 0)).toBe(0);
    expect(clampClipMove(project, "clip-3", 6_500_000)).toBe(6_500_000);
  });
});
