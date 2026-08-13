import type { ProjectDocument } from "@web-video-editor/domain";
import {
  MonotonicProjectClock,
  createMediabunnyDecoderQueueObservation,
  createSeekStream,
  selectVideoFrameByTimestamp,
  type MediabunnyAudioPlayback,
  type PlaybackMediaSource,
  type ResourceLifecycleSnapshot,
} from "@web-video-editor/media-runtime";
import type { StructuredLogger } from "@web-video-editor/observability";
import { Subject, type Subscription } from "rxjs";

import { PreviewDecoderClient, type DecodedPreviewFrame } from "./decoder";
import { PixiPreviewRenderer } from "./pixi-renderer";
import { resolveQualityProfile } from "./quality";
import { ProjectRuntimeAdapter } from "./runtime-adapter";
import type {
  PreviewRuntimeSnapshot,
  PreviewSource,
  RuntimeEvaluation,
} from "./types";

type DecodeJob = {
  generation: number;
  origin: "playback" | "seek";
  playheadUs: number;
  projectRevision: number;
  requestId: string;
  source: PreviewSource;
  sourceTimeUs: number;
};

const PLAYBACK_STARTUP_MAX_VIDEO_LAG_US = 500_000;

export type PreviewRuntimeOptions = {
  audio?: MediabunnyAudioPlayback;
  clock?: MonotonicProjectClock;
  decoder: PreviewDecoderClient;
  logger?: StructuredLogger;
  project: ProjectDocument;
  renderer: PixiPreviewRenderer;
  sources: readonly PreviewSource[];
};

function projectDurationUs(project: ProjectDocument): number {
  const clipEnd = project.clips.reduce(
    (maximum, clip) =>
      Math.max(
        maximum,
        clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs,
      ),
    0,
  );
  const textEnd = project.texts.reduce(
    (maximum, text) => Math.max(maximum, text.endUs),
    0,
  );
  return Math.max(clipEnd, textEnd);
}

export class PreviewRuntime {
  private readonly adapter: ProjectRuntimeAdapter;
  private readonly clock: MonotonicProjectClock;
  private readonly jobs = new Subject<DecodeJob>();
  private readonly listeners = new Set<() => void>();
  private readonly sources = new Map<string, PreviewSource>();
  private readonly frameTimes: number[] = [];
  private readonly unsubscribeDecoderStats: () => void;
  private seekSubscription?: Subscription;
  private animationFrame?: number;
  private lastPlaybackFrame = -1;
  private playbackDecodeInFlight = false;
  private pendingPlaybackTimeUs?: number;
  private requestCounter = 0;
  private transportGeneration = 0;
  private syncDroppedFrames = 0;
  private latestRequestId?: string;
  private project: ProjectDocument;
  private snapshot: PreviewRuntimeSnapshot;
  private disposed = false;

  constructor(private readonly options: PreviewRuntimeOptions) {
    this.project = options.project;
    this.clock = options.clock ?? new MonotonicProjectClock();
    for (const source of options.sources) {
      this.sources.set(source.assetId, source);
    }
    const profile = resolveQualityProfile(this.project, "preview");
    this.snapshot = {
      buffering: false,
      durationUs: projectDurationUs(this.project),
      metrics: {
        activeResources: options.decoder.activeResources(),
        audioActiveSources: 0,
        audioGeneration: 0,
        avDriftUs: 0,
        cacheHitRate:
          options.sources.length === 0
            ? 0
            : options.sources.filter((source) => source.cacheStatus === "hit")
                .length / options.sources.length,
        clockSource: "performance",
        clockTransportMode: this.clock.transport.mode,
        codecQueues: {
          audioDecoder: null,
          videoDecoder: createMediabunnyDecoderQueueObservation("VideoDecoder"),
        },
        decodeQueue: 0,
        droppedFrames: 0,
        fps: 0,
        frameTimestampErrorUs: 0,
        height: profile.height,
        playheadUs: 0,
        presentedPlayheadUs: 0,
        presentedFrames: 0,
        resyncs: 0,
        staleFrames: 0,
        timestampDrops: 0,
        width: profile.width,
      },
      playing: false,
      ready: true,
    };
    this.adapter = new ProjectRuntimeAdapter({
      logger: options.logger,
      renderTarget: options.renderer,
    });
    this.unsubscribeDecoderStats = options.decoder.subscribeStats(() => {
      if (!this.disposed) {
        this.refreshDecoderMetrics();
        this.notify();
      }
    });
    this.connectSeekStream();
    this.clock.seek(0, this.project.revision);
    this.seek(0);
  }

  getSnapshot = (): PreviewRuntimeSnapshot => this.snapshot;

  resourceSnapshot(): ResourceLifecycleSnapshot {
    return this.options.decoder.resourceSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setProject(project: ProjectDocument): void {
    const resume = this.snapshot.playing;
    if (resume || this.snapshot.buffering) {
      this.pause();
    }
    this.project = project;
    this.snapshot = {
      ...this.snapshot,
      durationUs: projectDurationUs(project),
    };
    this.seek(
      Math.min(this.snapshot.metrics.playheadUs, this.snapshot.durationUs),
    );
    if (resume) {
      this.play();
    }
  }

  setSources(sources: readonly PreviewSource[]): void {
    const resume = this.snapshot.playing;
    const playheadUs = this.snapshot.metrics.playheadUs;
    if (resume || this.snapshot.buffering) {
      this.pause();
    }
    this.sources.clear();
    for (const source of sources) {
      this.sources.set(source.assetId, source);
    }
    this.snapshot = {
      ...this.snapshot,
      metrics: {
        ...this.snapshot.metrics,
        cacheHitRate:
          sources.length === 0
            ? 0
            : sources.filter((source) => source.cacheStatus === "hit").length /
              sources.length,
      },
    };
    this.seek(playheadUs);
    if (resume) {
      this.play();
    }
  }

  setAudioSources(sources: ReadonlyMap<string, PlaybackMediaSource>): void {
    const audio = this.options.audio;
    if (!audio) {
      return;
    }
    const resume = this.snapshot.playing;
    const playheadUs = this.snapshot.metrics.playheadUs;
    if (resume || this.snapshot.buffering) {
      this.pause();
    }
    audio.setSources(sources);
    this.seek(playheadUs);
    if (resume) {
      this.play();
    }
  }

  seek(playheadUs: number): void {
    if (this.disposed) {
      return;
    }
    const resume = this.snapshot.playing;
    const clamped = Math.max(
      0,
      Math.min(Math.round(playheadUs), this.snapshot.durationUs),
    );
    this.transportGeneration += 1;
    this.playbackDecodeInFlight = false;
    this.pendingPlaybackTimeUs = undefined;
    this.stopAnimation();
    this.options.audio?.stop("seek-or-revision");
    this.clock.seek(clamped, this.project.revision);
    this.snapshot = {
      ...this.snapshot,
      buffering: false,
      playing: false,
    };
    this.requestFrame(clamped);
    if (resume) {
      this.beginPlayback(clamped);
    }
  }

  play(): void {
    if (this.disposed || this.snapshot.playing || this.snapshot.buffering) {
      return;
    }
    this.beginPlayback(this.snapshot.metrics.playheadUs);
  }

  pause(): void {
    if (!this.snapshot.playing && !this.snapshot.buffering) {
      return;
    }
    this.transportGeneration += 1;
    this.playbackDecodeInFlight = false;
    this.pendingPlaybackTimeUs = undefined;
    const playheadUs =
      this.clock.snapshot().state === "running"
        ? Math.min(this.clock.currentTimeUs(), this.snapshot.durationUs)
        : this.snapshot.metrics.playheadUs;
    this.stopAnimation();
    this.options.audio?.stop("pause");
    this.clock.pause();
    this.snapshot = {
      ...this.snapshot,
      buffering: false,
      metrics: {
        ...this.snapshot.metrics,
        playheadUs,
      },
      playing: false,
    };
    this.notify();
  }

  step(direction: -1 | 1): void {
    this.pause();
    const frameDurationUs =
      1_000_000 / resolveQualityProfile(this.project, "preview").frameRate;
    this.seek(this.snapshot.metrics.playheadUs + frameDurationUs * direction);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.pause();
    this.disposed = true;
    this.seekSubscription?.unsubscribe();
    this.jobs.complete();
    this.unsubscribeDecoderStats();
    this.adapter.dispose();
    this.options.decoder.dispose();
    void this.options.audio?.dispose();
    this.options.renderer.destroy();
    this.listeners.clear();
  }

  private beginPlayback(playheadUs: number): void {
    const transportGeneration = ++this.transportGeneration;
    this.lastPlaybackFrame = -1;
    this.snapshot = {
      ...this.snapshot,
      buffering: Boolean(this.options.audio),
      playing: true,
    };
    this.notify();

    if (!this.options.audio) {
      this.clock.start(playheadUs, this.project.revision);
      this.afterPlaybackStarted(transportGeneration, playheadUs);
      return;
    }
    void this.options.audio
      .start({
        clips: this.project.clips,
        projectDurationUs: this.snapshot.durationUs,
        projectRevision: this.project.revision,
        startTimeUs: playheadUs,
      })
      .then(
        (audio) => {
          if (
            transportGeneration !== this.transportGeneration ||
            this.disposed
          ) {
            return;
          }
          this.clock.start(
            playheadUs,
            this.project.revision,
            audio.hasAudio
              ? {
                  nowSeconds: audio.nowSeconds,
                  source: "audio",
                  startedAtSeconds: audio.startedAtSeconds,
                }
              : undefined,
          );
          this.afterPlaybackStarted(transportGeneration, playheadUs);
        },
        (error: unknown) => {
          if (
            transportGeneration !== this.transportGeneration ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            return;
          }
          this.options.audio?.stop("audio-start-failed");
          this.snapshot = {
            ...this.snapshot,
            buffering: false,
            playing: false,
          };
          this.setError(error);
        },
      );
  }

  private afterPlaybackStarted(
    transportGeneration: number,
    playheadUs: number,
  ): void {
    if (transportGeneration !== this.transportGeneration || this.disposed) {
      return;
    }
    const clock = this.clock.snapshot();
    const audio = this.options.audio?.stats();
    this.snapshot = {
      ...this.snapshot,
      buffering: false,
      metrics: {
        ...this.snapshot.metrics,
        audioActiveSources: audio?.activeSources ?? 0,
        audioGeneration: audio?.generation ?? 0,
        clockSource: clock.source,
        clockTransportMode: clock.transportMode,
        codecQueues: {
          audioDecoder: audio?.decoderQueue ?? null,
          videoDecoder: this.options.decoder.stats().decoderQueue,
        },
      },
    };
    this.requestPlaybackFrame(playheadUs);
    this.notify();
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  private requestFrame(
    playheadUs: number,
    origin: DecodeJob["origin"] = "seek",
  ): void {
    if (this.disposed) {
      return;
    }
    const clamped = Math.max(
      0,
      Math.min(Math.round(playheadUs), this.snapshot.durationUs),
    );
    const requestId = `preview-seek-${++this.requestCounter}`;
    this.latestRequestId = requestId;
    let evaluation: RuntimeEvaluation;
    try {
      evaluation = this.adapter.evaluate(this.project, clamped, requestId);
    } catch (error) {
      this.setError(error);
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      error: undefined,
      metrics: {
        ...this.snapshot.metrics,
        playheadUs: clamped,
      },
    };
    this.refreshDecoderMetrics();
    this.notify();

    if (!evaluation.video) {
      return;
    }
    const source = this.sources.get(evaluation.video.assetId);
    if (!source) {
      this.setError(
        new Error(
          `No proxy source is registered for asset "${evaluation.video.assetId}"`,
        ),
      );
      return;
    }
    this.jobs.next({
      generation: this.clock.snapshot().generation,
      origin,
      playheadUs: clamped,
      projectRevision: this.project.revision,
      requestId,
      source,
      sourceTimeUs: evaluation.video.sourceTimeUs,
    });
  }

  private requestPlaybackFrame(playheadUs: number): void {
    this.pendingPlaybackTimeUs = playheadUs;
    if (this.playbackDecodeInFlight || !this.snapshot.playing) {
      return;
    }
    const nextPlayheadUs = this.pendingPlaybackTimeUs;
    this.pendingPlaybackTimeUs = undefined;
    this.playbackDecodeInFlight = true;
    this.requestFrame(nextPlayheadUs, "playback");
  }

  private readonly tick = () => {
    if (!this.snapshot.playing || this.disposed) {
      return;
    }
    const nextUs = this.clock.currentTimeUs();
    if (nextUs >= this.snapshot.durationUs) {
      this.pause();
      this.clock.seek(this.snapshot.durationUs, this.project.revision);
      this.requestFrame(this.snapshot.durationUs);
      return;
    }
    const frameRate = resolveQualityProfile(this.project, "preview").frameRate;
    const frame = Math.floor((nextUs * frameRate) / 1_000_000);
    if (frame !== this.lastPlaybackFrame) {
      this.lastPlaybackFrame = frame;
      this.requestPlaybackFrame(nextUs);
    }
    this.animationFrame = requestAnimationFrame(this.tick);
  };

  private stopAnimation(): void {
    if (this.animationFrame !== undefined) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = undefined;
    }
  }

  private connectSeekStream(): void {
    this.seekSubscription = createSeekStream(this.jobs, (job, signal) =>
      this.options.decoder
        .decode(
          job.source,
          job.sourceTimeUs,
          job.projectRevision,
          job.requestId,
          job.generation,
          signal,
        )
        .then((decoded) => ({ decoded, job })),
    ).subscribe({
      error: (error: unknown) => {
        this.playbackDecodeInFlight = false;
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.setError(error);
        }
        if (!this.disposed) {
          this.connectSeekStream();
          if (this.snapshot.playing) {
            this.requestPlaybackFrame(
              Math.min(this.clock.currentTimeUs(), this.snapshot.durationUs),
            );
          }
        }
      },
      next: ({ decoded, job }) => this.present(decoded, job),
    });
  }

  private present(decoded: DecodedPreviewFrame, job: DecodeJob): void {
    let resyncTimeUs: number | undefined;
    try {
      if (
        job.requestId !== this.latestRequestId ||
        job.projectRevision !== this.project.revision
      ) {
        return;
      }
      const clock = this.clock.snapshot();
      const masterTimeUs = this.snapshot.playing
        ? Math.min(clock.timeUs, this.snapshot.durationUs)
        : job.playheadUs;
      const timing = selectVideoFrameByTimestamp({
        currentGeneration: clock.generation,
        currentRevision: this.project.revision,
        frameGeneration: decoded.generation,
        frameRevision: job.projectRevision,
        frameSourceTimeUs: decoded.sourceTimeUs,
        masterTimeUs,
        maxVideoLagUs:
          job.origin === "playback" && this.snapshot.metrics.fps < 5
            ? PLAYBACK_STARTUP_MAX_VIDEO_LAG_US
            : undefined,
        requestedProjectTimeUs: job.playheadUs,
        requestedSourceTimeUs: job.sourceTimeUs,
      });
      this.snapshot = {
        ...this.snapshot,
        metrics: {
          ...this.snapshot.metrics,
          avDriftUs: timing.avDriftUs,
          frameTimestampErrorUs: timing.frameTimestampErrorUs,
        },
      };
      if (timing.drop) {
        this.syncDroppedFrames += 1;
        this.snapshot = {
          ...this.snapshot,
          metrics: {
            ...this.snapshot.metrics,
            resyncs: this.snapshot.metrics.resyncs + (timing.resync ? 1 : 0),
            timestampDrops: this.snapshot.metrics.timestampDrops + 1,
          },
        };
        this.options.logger?.log({
          event: "frame.dropped",
          input: {
            frameSourceTimeUs: decoded.sourceTimeUs,
            masterTimeUs,
            requestedSourceTimeUs: job.sourceTimeUs,
          },
          level: timing.resync ? "warn" : "debug",
          marker: "[RENDER]",
          output: {
            avDriftUs: timing.avDriftUs,
            frameTimestampErrorUs: timing.frameTimestampErrorUs,
            reason: timing.reason,
            resync: timing.resync,
          },
          projectRevision: job.projectRevision,
          requestId: job.requestId,
        });
        if (timing.resync) {
          resyncTimeUs = masterTimeUs;
        }
        return;
      }
      this.options.renderer.present(decoded.frame, {
        playheadUs: job.playheadUs,
        projectRevision: job.projectRevision,
        requestId: job.requestId,
      });
      const now = performance.now();
      this.frameTimes.push(now);
      while (
        this.frameTimes[0] !== undefined &&
        this.frameTimes[0] < now - 1_000
      ) {
        this.frameTimes.shift();
      }
      this.snapshot = {
        ...this.snapshot,
        error: undefined,
        metrics: {
          ...this.snapshot.metrics,
          fps: this.frameTimes.length,
          presentedPlayheadUs: job.playheadUs,
          presentedFrames: this.snapshot.metrics.presentedFrames + 1,
        },
      };
    } finally {
      decoded.release();
      this.refreshDecoderMetrics();
      this.notify();
      if (job.origin === "playback") {
        this.playbackDecodeInFlight = false;
        if (this.snapshot.playing && !this.disposed) {
          const latestClockUs = Math.min(
            this.clock.currentTimeUs(),
            this.snapshot.durationUs,
          );
          this.requestPlaybackFrame(
            resyncTimeUs ??
              Math.max(this.pendingPlaybackTimeUs ?? 0, latestClockUs),
          );
        }
      } else if (resyncTimeUs !== undefined && !this.disposed) {
        this.requestFrame(resyncTimeUs);
      }
    }
  }

  private refreshDecoderMetrics(): void {
    const stats = this.options.decoder.stats();
    const audio = this.options.audio?.stats();
    this.snapshot = {
      ...this.snapshot,
      metrics: {
        ...this.snapshot.metrics,
        activeResources: this.options.decoder.activeResources(),
        audioActiveSources: audio?.activeSources ?? 0,
        audioGeneration: audio?.generation ?? 0,
        codecQueues: {
          audioDecoder: audio?.decoderQueue ?? null,
          videoDecoder: stats.decoderQueue,
        },
        decodeQueue: stats.decodeQueue,
        droppedFrames: stats.droppedFrames + this.syncDroppedFrames,
        staleFrames: stats.staleFrames,
      },
    };
  }

  private setError(error: unknown): void {
    this.snapshot = {
      ...this.snapshot,
      error: error instanceof Error ? error.message : String(error),
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
