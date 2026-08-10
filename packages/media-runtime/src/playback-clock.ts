import {
  createPlaybackClock,
  type PlaybackClock,
  type PlaybackClockSnapshot,
  type SharedMemoryCapability,
} from "./shared-memory";

export type ProjectClockSource = "audio" | "performance";

export type ProjectClockAnchor = {
  nowSeconds: () => number;
  source: ProjectClockSource;
  startedAtSeconds?: number;
};

export type ProjectClockSnapshot = {
  generation: number;
  projectRevision: number;
  source: ProjectClockSource;
  state: "paused" | "running";
  timeUs: number;
  transportMode: PlaybackClock["mode"];
};

export type MonotonicProjectClockOptions = SharedMemoryCapability & {
  performanceNow?: () => number;
  publishFallback?: (snapshot: PlaybackClockSnapshot) => void;
};

function validTime(timeUs: number): number {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError("timeUs must be a non-negative safe integer");
  }
  return timeUs;
}

export class MonotonicProjectClock {
  readonly transport: PlaybackClock;

  private readonly performanceNow: () => number;
  private anchorNowSeconds: () => number;
  private anchorProjectUs = 0;
  private anchorSeconds = 0;
  private generation = 0;
  private lastTimeUs = 0;
  private projectRevision = 0;
  private source: ProjectClockSource = "performance";
  private state: "paused" | "running" = "paused";

  constructor(options: MonotonicProjectClockOptions = {}) {
    this.performanceNow = options.performanceNow ?? (() => performance.now());
    this.anchorNowSeconds = () => this.performanceNow() / 1_000;
    this.transport = createPlaybackClock(options);
    this.publish();
  }

  start(
    timeUs: number,
    projectRevision: number,
    anchor?: ProjectClockAnchor,
  ): ProjectClockSnapshot {
    this.generation += 1;
    this.projectRevision = projectRevision;
    this.source = anchor?.source ?? "performance";
    this.anchorNowSeconds =
      anchor?.nowSeconds ?? (() => this.performanceNow() / 1_000);
    this.anchorSeconds = anchor?.startedAtSeconds ?? this.anchorNowSeconds();
    this.anchorProjectUs = validTime(timeUs);
    this.lastTimeUs = timeUs;
    this.state = "running";
    this.publish();
    return this.snapshot();
  }

  pause(): ProjectClockSnapshot {
    if (this.state === "running") {
      this.lastTimeUs = this.currentTimeUs();
      this.anchorProjectUs = this.lastTimeUs;
      this.state = "paused";
      this.generation += 1;
      this.publish();
    }
    return this.snapshot();
  }

  seek(
    timeUs: number,
    projectRevision = this.projectRevision,
  ): ProjectClockSnapshot {
    this.generation += 1;
    this.projectRevision = projectRevision;
    this.anchorProjectUs = validTime(timeUs);
    this.lastTimeUs = timeUs;
    this.state = "paused";
    this.publish();
    return this.snapshot();
  }

  currentTimeUs(): number {
    if (this.state === "running") {
      const elapsedUs = Math.max(
        0,
        Math.round((this.anchorNowSeconds() - this.anchorSeconds) * 1_000_000),
      );
      this.lastTimeUs = Math.max(
        this.lastTimeUs,
        this.anchorProjectUs + elapsedUs,
      );
      this.publish();
    }
    return this.lastTimeUs;
  }

  snapshot(): ProjectClockSnapshot {
    return {
      generation: this.generation,
      projectRevision: this.projectRevision,
      source: this.source,
      state: this.state,
      timeUs: this.currentTimeUs(),
      transportMode: this.transport.mode,
    };
  }

  private publish(): void {
    this.transport.write({
      state: this.state,
      timeUs: this.lastTimeUs,
    });
  }
}
