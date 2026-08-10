import { describe, expect, it } from "vitest";

import { selectVideoFrameByTimestamp } from "./playback-sync";

const base = {
  currentGeneration: 4,
  currentRevision: 2,
  frameGeneration: 4,
  frameRevision: 2,
  frameSourceTimeUs: 1_000_000,
  masterTimeUs: 3_000_000,
  requestedProjectTimeUs: 3_020_000,
  requestedSourceTimeUs: 1_020_000,
};

describe("selectVideoFrameByTimestamp", () => {
  it("presents a timestamp-near frame and reports A/V drift", () => {
    expect(selectVideoFrameByTimestamp(base)).toEqual({
      avDriftUs: 20_000,
      drop: false,
      frameTimestampErrorUs: -20_000,
      resync: false,
    });
  });

  it("drops stale generations and revisions before presentation", () => {
    expect(
      selectVideoFrameByTimestamp({ ...base, frameGeneration: 3 }),
    ).toMatchObject({
      drop: true,
      reason: "stale-generation",
      resync: false,
    });
    expect(
      selectVideoFrameByTimestamp({ ...base, frameRevision: 1 }),
    ).toMatchObject({
      drop: true,
      reason: "stale-revision",
      resync: false,
    });
  });

  it("drops lagging video and requests a resync at the configured threshold", () => {
    expect(
      selectVideoFrameByTimestamp({
        ...base,
        masterTimeUs: 3_300_000,
        requestedProjectTimeUs: 3_000_000,
      }),
    ).toMatchObject({
      avDriftUs: -300_000,
      drop: true,
      reason: "master-clock-lag",
      resync: true,
    });
  });

  it("rejects a frame whose timestamp is ahead of the requested source time", () => {
    expect(
      selectVideoFrameByTimestamp({
        ...base,
        frameSourceTimeUs: 1_100_001,
      }),
    ).toMatchObject({
      drop: true,
      reason: "frame-ahead-of-request",
    });
  });
});
