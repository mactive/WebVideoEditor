import type { StructuredLogger } from "@web-video-editor/observability";
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  Input,
  UrlSource,
  type Source,
} from "mediabunny";

import { getOpfsProxyFile } from "./proxy-cache";
import {
  MediabunnyDecoderQueueAdapter,
  type CodecQueueObservation,
} from "./scheduler";

export type PlaybackMediaSource =
  | {
      blob: Blob;
      kind: "blob";
    }
  | {
      cacheKey: string;
      kind: "opfs-proxy";
      path?: string;
    }
  | {
      kind: "url";
      url: string;
    };

export type AudioTimelineClip = {
  assetId: string;
  id: string;
  sourceEndUs: number;
  sourceStartUs: number;
  timelineStartUs: number;
};

export type AudioPlaybackRequest = {
  clips: readonly AudioTimelineClip[];
  projectDurationUs: number;
  projectRevision: number;
  startTimeUs: number;
};

export type AudioPlaybackStart = {
  generation: number;
  hasAudio: boolean;
  nowSeconds: () => number;
  startedAtSeconds: number;
};

export type AudioPlaybackStats = {
  activeGenerations: number[];
  activeSources: number;
  decoderQueue: CodecQueueObservation;
  decodedBuffers: number;
  generation: number;
  projectRevision: number;
  scheduledBuffers: number;
  staleBuffers: number;
  stoppedSources: number;
};

export type DecodedAudioBuffer = {
  buffer: AudioBuffer;
  durationSec: number;
  timestampSec: number;
};

export type AudioWindowDecoder = (
  source: PlaybackMediaSource,
  startSec: number,
  endSec: number,
  signal: AbortSignal,
) => Promise<DecodedAudioBuffer[]>;

type ScheduledBuffer = DecodedAudioBuffer & {
  durationSec: number;
  offsetSec: number;
  projectStartUs: number;
};

export type MediabunnyAudioPlaybackOptions = {
  audioContext?: AudioContext;
  decodeWindow?: AudioWindowDecoder;
  logger?: StructuredLogger;
  lookAheadUs?: number;
  onDecodedBuffer?: (buffer: AudioBuffer, generation: number) => void;
  scheduleLeadSec?: number;
  sources: ReadonlyMap<string, PlaybackMediaSource>;
};

function abortError(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

function sourceForPlayback(
  source: PlaybackMediaSource,
): Promise<Source> | Source {
  switch (source.kind) {
    case "blob":
      return new BlobSource(source.blob, { maxCacheSize: 16 * 1024 * 1024 });
    case "opfs-proxy":
      return getOpfsProxyFile(source.cacheKey, source.path ?? "proxy.mp4").then(
        (file) => new BlobSource(file, { maxCacheSize: 16 * 1024 * 1024 }),
      );
    case "url":
      return new UrlSource(source.url, {
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      });
  }
}

export async function decodeAudioWindow(
  source: PlaybackMediaSource,
  startSec: number,
  endSec: number,
  signal: AbortSignal,
): Promise<DecodedAudioBuffer[]> {
  signal.throwIfAborted();
  const input = new Input({
    formats: ALL_FORMATS,
    source: await sourceForPlayback(source),
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    signal.throwIfAborted();
    if (!track) {
      return [];
    }
    const sink = new AudioBufferSink(track);
    const buffers: DecodedAudioBuffer[] = [];
    for await (const decoded of sink.buffers(startSec, endSec)) {
      signal.throwIfAborted();
      buffers.push({
        buffer: decoded.buffer,
        durationSec: decoded.duration,
        timestampSec: decoded.timestamp,
      });
    }
    return buffers;
  } finally {
    input.dispose();
  }
}

export class MediabunnyAudioPlayback {
  private readonly context: AudioContext;
  private readonly decodeWindow: AudioWindowDecoder;
  private readonly decoderQueue: MediabunnyDecoderQueueAdapter;
  private readonly lookAheadUs: number;
  private readonly nodes = new Map<AudioBufferSourceNode, number>();
  private readonly ownsContext: boolean;
  private readonly scheduleLeadSec: number;
  private readonly sources = new Map<string, PlaybackMediaSource>();
  private abortController?: AbortController;
  private anchorProjectUs = 0;
  private anchorSeconds = 0;
  private decodedBuffers = 0;
  private disposed = false;
  private generation = 0;
  private projectDurationUs = 0;
  private projectRevision = 0;
  private refillTimer?: ReturnType<typeof setTimeout>;
  private request?: AudioPlaybackRequest;
  private scheduledBuffers = 0;
  private scheduledThroughUs = 0;
  private staleBuffers = 0;
  private stoppedSources = 0;

  constructor(private readonly options: MediabunnyAudioPlaybackOptions) {
    this.ownsContext = !options.audioContext;
    this.context = options.audioContext ?? new AudioContext();
    this.decodeWindow = options.decodeWindow ?? decodeAudioWindow;
    this.decoderQueue = new MediabunnyDecoderQueueAdapter("AudioDecoder", {
      concurrency: 1,
      highWatermark: 1,
      logger: options.logger,
    });
    this.lookAheadUs = options.lookAheadUs ?? 4_000_000;
    this.scheduleLeadSec = options.scheduleLeadSec ?? 0.06;
    this.setSources(options.sources);
  }

  async start(request: AudioPlaybackRequest): Promise<AudioPlaybackStart> {
    if (this.disposed) {
      throw new Error("MediabunnyAudioPlayback is disposed");
    }
    this.invalidate("playback-restarted");
    const generation = this.generation;
    this.request = request;
    this.projectRevision = request.projectRevision;
    this.projectDurationUs = request.projectDurationUs;
    this.anchorProjectUs = request.startTimeUs;
    this.scheduledThroughUs = request.startTimeUs;
    await this.context.resume();
    const controller = new AbortController();
    this.abortController = controller;
    const windowEndUs = Math.min(
      request.projectDurationUs,
      request.startTimeUs + this.lookAheadUs,
    );
    const buffers = await this.decodeTimelineWindow(
      request.startTimeUs,
      windowEndUs,
      controller.signal,
    );
    if (
      generation !== this.generation ||
      request.projectRevision !== this.projectRevision
    ) {
      this.staleBuffers += buffers.length;
      throw abortError("Audio playback start was superseded");
    }

    this.anchorSeconds = this.context.currentTime + this.scheduleLeadSec;
    for (const buffer of buffers) {
      this.schedule(buffer, generation);
    }
    this.scheduledThroughUs = windowEndUs;
    this.scheduleRefill(generation);
    this.options.logger?.log({
      event: "completed",
      input: {
        startTimeUs: request.startTimeUs,
        windowEndUs,
      },
      level: "info",
      marker: "[DECODE]",
      output: {
        buffers: buffers.length,
        generation,
        path: "mediabunny-webcodecs-audiobuffer",
      },
      projectRevision: request.projectRevision,
    });
    return {
      generation,
      hasAudio: buffers.length > 0,
      nowSeconds: () => this.context.currentTime,
      startedAtSeconds: this.anchorSeconds,
    };
  }

  stop(reason = "playback-stopped"): void {
    this.invalidate(reason);
  }

  setSources(sources: ReadonlyMap<string, PlaybackMediaSource>): void {
    this.sources.clear();
    for (const [assetId, source] of sources) {
      this.sources.set(assetId, source);
    }
    if (this.request) {
      this.invalidate("sources-updated");
    }
  }

  stats(): AudioPlaybackStats {
    return {
      activeGenerations: [...new Set(this.nodes.values())],
      activeSources: this.nodes.size,
      decoderQueue: this.decoderQueue.stats(),
      decodedBuffers: this.decodedBuffers,
      generation: this.generation,
      projectRevision: this.projectRevision,
      scheduledBuffers: this.scheduledBuffers,
      staleBuffers: this.staleBuffers,
      stoppedSources: this.stoppedSources,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.invalidate("audio-playback-disposed");
    this.decoderQueue.dispose();
    if (this.ownsContext) {
      await this.context.close();
    }
  }

  private async decodeTimelineWindow(
    startUs: number,
    endUs: number,
    signal: AbortSignal,
  ): Promise<ScheduledBuffer[]> {
    const request = this.request;
    if (!request || endUs <= startUs) {
      return [];
    }
    const output: ScheduledBuffer[] = [];
    for (const clip of request.clips) {
      const clipEndUs =
        clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs;
      const intersectionStartUs = Math.max(startUs, clip.timelineStartUs);
      const intersectionEndUs = Math.min(endUs, clipEndUs);
      const source = this.sources.get(clip.assetId);
      if (!source || intersectionEndUs <= intersectionStartUs) {
        continue;
      }
      const sourceStartUs =
        clip.sourceStartUs + intersectionStartUs - clip.timelineStartUs;
      const sourceEndUs =
        clip.sourceStartUs + intersectionEndUs - clip.timelineStartUs;
      const decodeTask = this.decoderQueue.schedule(
        `audio-${this.projectRevision}-${this.generation}-${clip.id}-${sourceStartUs}`,
        (queueSignal) =>
          this.decodeWindow(
            source,
            sourceStartUs / 1_000_000,
            sourceEndUs / 1_000_000,
            queueSignal,
          ).then((buffers) => {
            if (queueSignal.aborted) {
              this.staleBuffers += buffers.length;
              queueSignal.throwIfAborted();
            }
            return buffers;
          }),
        signal,
      );
      const decoded = await decodeTask.result;
      this.decodedBuffers += decoded.length;
      for (const buffer of decoded) {
        const bufferStartUs = Math.round(buffer.timestampSec * 1_000_000);
        const bufferEndUs = Math.round(
          (buffer.timestampSec + buffer.durationSec) * 1_000_000,
        );
        const audibleStartUs = Math.max(bufferStartUs, sourceStartUs);
        const audibleEndUs = Math.min(bufferEndUs, sourceEndUs);
        if (audibleEndUs <= audibleStartUs) {
          continue;
        }
        output.push({
          ...buffer,
          durationSec: (audibleEndUs - audibleStartUs) / 1_000_000,
          offsetSec: (audibleStartUs - bufferStartUs) / 1_000_000,
          projectStartUs:
            clip.timelineStartUs + audibleStartUs - clip.sourceStartUs,
        });
        this.options.onDecodedBuffer?.(buffer.buffer, this.generation);
      }
    }
    return output;
  }

  private schedule(buffer: ScheduledBuffer, generation: number): void {
    let when =
      this.anchorSeconds +
      (buffer.projectStartUs - this.anchorProjectUs) / 1_000_000;
    let offsetSec = buffer.offsetSec;
    let durationSec = buffer.durationSec;
    if (when < this.context.currentTime) {
      const lateBySec = this.context.currentTime - when;
      when = this.context.currentTime;
      offsetSec += lateBySec;
      durationSec -= lateBySec;
    }
    if (durationSec <= 0 || generation !== this.generation) {
      this.staleBuffers += 1;
      return;
    }
    const node = this.context.createBufferSource();
    node.buffer = buffer.buffer;
    node.connect(this.context.destination);
    node.onended = () => this.nodes.delete(node);
    this.nodes.set(node, generation);
    node.start(when, offsetSec);
    node.stop(when + durationSec);
    this.scheduledBuffers += 1;
  }

  private scheduleRefill(generation: number): void {
    if (this.scheduledThroughUs >= this.projectDurationUs) {
      return;
    }
    const delayMs = Math.max(
      100,
      ((this.scheduledThroughUs -
        this.anchorProjectUs -
        Math.min(1_000_000, this.lookAheadUs / 2)) /
        1_000_000) *
        1_000,
    );
    this.refillTimer = setTimeout(() => {
      void this.refill(generation);
    }, delayMs);
  }

  private async refill(generation: number): Promise<void> {
    const signal = this.abortController?.signal;
    const request = this.request;
    if (!signal || !request || generation !== this.generation) {
      return;
    }
    const startUs = this.scheduledThroughUs;
    const endUs = Math.min(this.projectDurationUs, startUs + this.lookAheadUs);
    try {
      const buffers = await this.decodeTimelineWindow(startUs, endUs, signal);
      if (
        generation !== this.generation ||
        request.projectRevision !== this.projectRevision
      ) {
        this.staleBuffers += buffers.length;
        return;
      }
      for (const buffer of buffers) {
        this.schedule(buffer, generation);
      }
      this.scheduledThroughUs = endUs;
      this.scheduleRefill(generation);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        this.options.logger?.log({
          error,
          event: "failed",
          input: { startUs, endUs, generation },
          level: "error",
          marker: "[DECODE]",
          projectRevision: request.projectRevision,
        });
      }
    }
  }

  private invalidate(reason: string): void {
    this.generation += 1;
    this.abortController?.abort(reason);
    this.abortController = undefined;
    if (this.refillTimer !== undefined) {
      clearTimeout(this.refillTimer);
      this.refillTimer = undefined;
    }
    for (const node of this.nodes.keys()) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // A source may already have ended between the Set iteration and stop().
      }
      node.disconnect();
      this.stoppedSources += 1;
    }
    this.nodes.clear();
    this.options.logger?.log({
      event: "request.cancelled",
      input: { reason },
      level: "debug",
      marker: "[SEEK]",
      output: { generation: this.generation, activeSources: 0 },
      projectRevision: this.projectRevision,
    });
  }
}
