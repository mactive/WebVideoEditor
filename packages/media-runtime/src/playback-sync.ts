export type VideoDropReason =
  | "frame-ahead-of-request"
  | "master-clock-lag"
  | "stale-generation"
  | "stale-revision";

export type VideoTimingDecision = {
  avDriftUs: number;
  drop: boolean;
  frameTimestampErrorUs: number;
  reason?: VideoDropReason;
  resync: boolean;
};

export type VideoTimingInput = {
  currentGeneration: number;
  currentRevision: number;
  frameGeneration: number;
  frameRevision: number;
  frameSourceTimeUs: number;
  masterTimeUs: number;
  maxFrameLeadUs?: number;
  maxVideoLagUs?: number;
  requestedProjectTimeUs: number;
  requestedSourceTimeUs: number;
  resyncThresholdUs?: number;
};

export function selectVideoFrameByTimestamp(
  input: VideoTimingInput,
): VideoTimingDecision {
  const avDriftUs = input.requestedProjectTimeUs - input.masterTimeUs;
  const frameTimestampErrorUs =
    input.frameSourceTimeUs - input.requestedSourceTimeUs;
  if (input.frameRevision !== input.currentRevision) {
    return {
      avDriftUs,
      drop: true,
      frameTimestampErrorUs,
      reason: "stale-revision",
      resync: false,
    };
  }
  if (input.frameGeneration !== input.currentGeneration) {
    return {
      avDriftUs,
      drop: true,
      frameTimestampErrorUs,
      reason: "stale-generation",
      resync: false,
    };
  }
  if (frameTimestampErrorUs > (input.maxFrameLeadUs ?? 50_000)) {
    return {
      avDriftUs,
      drop: true,
      frameTimestampErrorUs,
      reason: "frame-ahead-of-request",
      resync: false,
    };
  }
  const maxVideoLagUs = input.maxVideoLagUs ?? 100_000;
  if (avDriftUs < -maxVideoLagUs) {
    return {
      avDriftUs,
      drop: true,
      frameTimestampErrorUs,
      reason: "master-clock-lag",
      resync:
        Math.abs(avDriftUs) >= (input.resyncThresholdUs ?? maxVideoLagUs * 2),
    };
  }
  return {
    avDriftUs,
    drop: false,
    frameTimestampErrorUs,
    resync: false,
  };
}
