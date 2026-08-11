import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  VideoSampleSource,
  type AudioSample,
  type InputAudioTrack,
  type InputVideoTrack,
  type Source,
} from "mediabunny";
import {
  initMediaWasm,
  type MediaWasmSdk,
  type PcmWaveformSession,
} from "@web-video-editor/media-wasm";
import type { StructuredLogger } from "@web-video-editor/observability";

import type { BrowserMediaSource } from "./probe-types";
import type { ProxyCacheAdapter, ProxyCacheTransaction } from "./proxy-cache";
import { createProxyCacheKey } from "./proxy-cache";
import {
  MEDIA_PROXY_RESULT_VERSION,
  calculateProxyDimensions,
  resolveProxyParameters,
  type MediaProxyProgress,
  type MediaProxyResult,
  type ProxyPcmSampleCountDiagnostics,
  type ProxyCacheStats,
  type ProxyGenerationParameters,
  type ProxyImageArtifact,
  type ProxyKeyframe,
  type ProxyManifest,
} from "./proxy-types";

const PROGRESS_STATS_SAMPLE_INTERVAL_MS = 2_000;
const PCM_SAMPLE_COUNT_TOLERANCE_SEC = 0.1;
const PCM_SAMPLE_COUNT_MIN_TOLERANCE = 2_048;

type GenerateMediaProxyOptions = {
  cache: ProxyCacheAdapter;
  fingerprint: string;
  logger?: StructuredLogger;
  onProgress?: (progress: MediaProxyProgress) => void;
  parameters?: Partial<ProxyGenerationParameters>;
  requestId?: string;
  signal?: AbortSignal;
  source: BrowserMediaSource;
  wasm?: MediaWasmSdk;
};

type PrimaryTracks = {
  audio: InputAudioTrack | null;
  video: InputVideoTrack;
};

class PcmSampleCountMismatchError extends Error {
  constructor(readonly diagnostics: ProxyPcmSampleCountDiagnostics) {
    super(
      `Decoded PCM sample count mismatch: expected ${diagnostics.expected}, received ${diagnostics.received}, delta ${diagnostics.delta}, tolerance ${diagnostics.tolerance}, strategy ${diagnostics.strategy}`,
    );
    this.name = "PcmSampleCountMismatchError";
  }
}

function browserSource(source: BrowserMediaSource): Source {
  return "blob" in source
    ? new BlobSource(source.blob, { maxCacheSize: 16 * 1024 * 1024 })
    : new UrlSource(source.url, {
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      });
}

async function primaryTracks(input: Input): Promise<PrimaryTracks> {
  const video = await input.getPrimaryVideoTrack();
  if (!video) {
    throw new Error("Media contains no primary video track");
  }
  const audio =
    (await video.getPrimaryPairableAudioTrack()) ??
    (await input.getPrimaryAudioTrack());
  return { audio, video };
}

function effectiveDuration(
  durationSec: number,
  parameters: ProxyGenerationParameters,
): number {
  return Math.min(durationSec, parameters.maxDurationSec ?? durationSec);
}

function timestampSeries(
  durationSec: number,
  intervalSec: number,
  maxCount: number,
): number[] {
  const timestamps = [0];
  for (
    let timestamp = intervalSec;
    timestamp < durationSec;
    timestamp += intervalSec
  ) {
    timestamps.push(timestamp);
  }
  if (timestamps.length > maxCount) {
    return Array.from({ length: maxCount }, (_, index) =>
      index === 0
        ? 0
        : (durationSec * index) / Math.max(1, maxCount - 1),
    );
  }
  return timestamps;
}

async function imageBlob(
  sample: Awaited<ReturnType<VideoSampleSink["getSample"]>>,
  width: number,
  height: number,
): Promise<Blob> {
  if (!sample) {
    throw new Error("No decoded video sample is available for thumbnail");
  }
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("OffscreenCanvas 2D context is unavailable");
  }
  sample.draw(context, 0, 0, width, height);
  return canvas.convertToBlob({ quality: 0.82, type: "image/webp" });
}

async function createImages(
  track: InputVideoTrack,
  durationSec: number,
  parameters: ProxyGenerationParameters,
  outputDimensions: { height: number; width: number },
  transaction: ProxyCacheTransaction,
  report: (stage: MediaProxyProgress["stage"], fields?: object) => void,
  signal?: AbortSignal,
): Promise<{
  cover: ProxyImageArtifact;
  thumbnails: ProxyImageArtifact[];
}> {
  const width = Math.min(parameters.thumbnailWidth, outputDimensions.width);
  const height = Math.max(
    2,
    Math.round((width * outputDimensions.height) / outputDimensions.width),
  );
  const timestamps = timestampSeries(
    durationSec,
    parameters.thumbnailIntervalSec,
    parameters.maxThumbnailCount,
  );
  const sink = new VideoSampleSink(track);
  const thumbnails: ProxyImageArtifact[] = [];
  let cover: ProxyImageArtifact | undefined;
  let index = 0;

  for await (const sample of sink.samplesAtTimestamps(timestamps)) {
    signal?.throwIfAborted();
    const timestampSec = timestamps[index];
    if (timestampSec === undefined || !sample) {
      index += 1;
      continue;
    }
    try {
      const blob = await imageBlob(sample, width, height);
      const path = `thumbnail-${String(index).padStart(4, "0")}.webp`;
      await transaction.write(path, blob);
      const artifact: ProxyImageArtifact = {
        byteLength: blob.size,
        height,
        mimeType: blob.type,
        path,
        timestampSec,
        width,
      };
      thumbnails.push(artifact);
      if (!cover) {
        const coverPath = "cover.webp";
        await transaction.write(coverPath, blob);
        cover = { ...artifact, path: coverPath };
      }
    } finally {
      sample.close();
    }
    index += 1;
    report("thumbnails", {
      durationSec,
      processedTimeSec: timestampSec,
    });
  }
  if (!cover) {
    throw new Error("Unable to decode a cover frame");
  }
  return { cover, thumbnails };
}

function monoPcm(sample: AudioSample): Float32Array {
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { format: "f32-planar", planeIndex: channel });
    channels.push(plane);
  }
  if (channels.length === 1) {
    return channels[0]!;
  }
  const mixed = new Float32Array(sample.numberOfFrames);
  for (const channel of channels) {
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) + (channel[index] ?? 0);
    }
  }
  for (let index = 0; index < mixed.length; index += 1) {
    mixed[index] = (mixed[index] ?? 0) / channels.length;
  }
  return mixed;
}

function trimAudioSample(
  sample: AudioSample,
  durationSec: number,
): AudioSample | null {
  const startFrame =
    sample.timestamp < 0
      ? Math.round(-sample.timestamp * sample.sampleRate)
      : 0;
  const endFrame =
    sample.timestamp + sample.duration > durationSec
      ? Math.round((durationSec - sample.timestamp) * sample.sampleRate)
      : sample.numberOfFrames;
  if (endFrame <= startFrame) {
    return null;
  }
  return startFrame === 0 && endFrame === sample.numberOfFrames
    ? sample
    : sample.trim(startFrame, endFrame);
}

function pcmSampleCountTolerance(sampleRate: number): number {
  return sampleRate > 0
    ? Math.max(
        PCM_SAMPLE_COUNT_MIN_TOLERANCE,
        Math.round(sampleRate * PCM_SAMPLE_COUNT_TOLERANCE_SEC),
      )
    : 0;
}

function pcmSampleCountDiagnostics(
  expected: number,
  received: number,
  sampleRate: number,
): ProxyPcmSampleCountDiagnostics | undefined {
  const delta = received - expected;
  if (delta === 0) {
    return undefined;
  }
  const tolerance = pcmSampleCountTolerance(sampleRate);
  const strategy =
    Math.abs(delta) > tolerance
      ? "fail"
      : delta < 0
        ? "pad-silence"
        : "truncate-tail";
  return {
    delta,
    expected,
    received,
    strategy,
    tolerance,
  };
}

async function transcode(
  input: Input,
  tracks: PrimaryTracks,
  durationSec: number,
  dimensions: { height: number; width: number },
  parameters: ProxyGenerationParameters,
  transaction: ProxyCacheTransaction,
  waveform: PcmWaveformSession,
  expectedWaveformSamples: number,
  report: (stage: MediaProxyProgress["stage"], fields?: object) => void,
  signal?: AbortSignal,
): Promise<{
  keyframes: ProxyKeyframe[];
  outputBytes: number;
  decodedSampleCount: number;
  waveformSampleCount: number;
}> {
  const writable = await transaction.createWritable("proxy.mp4");
  const target = new StreamTarget(writable, {
    chunked: true,
    chunkSize: 4 * 1024 * 1024,
  });
  let outputBytes = 0;
  target.on("write", ({ end }) => {
    outputBytes = Math.max(outputBytes, end);
  });
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: "fragmented",
      minimumFragmentDuration: 1,
    }),
    target,
  });
  const keyframes: ProxyKeyframe[] = [];
  const videoSource = new VideoSampleSource({
    codec: "avc",
    hardwareAcceleration: "no-preference",
    keyFrameInterval: parameters.keyFrameIntervalSec,
    onEncodedPacket: (packet) => {
      if (packet.type === "key") {
        keyframes.push({
          byteLength: packet.byteLength,
          durationSec: packet.duration,
          sequenceNumber: packet.sequenceNumber,
          timestampSec: packet.timestamp,
        });
      }
    },
    quality: new Quality("medium"),
    transform: {
      alpha: "discard",
      fit: "fill",
      frameRate: parameters.frameRate,
      height: dimensions.height,
      width: dimensions.width,
    },
  });
  output.addVideoTrack(videoSource, {
    frameRate: parameters.frameRate,
    rotation: 0,
  });

  const audioSource = tracks.audio
    ? new AudioSampleSource({
        codec: "aac",
        quality: new Quality("high"),
      })
    : undefined;
  if (audioSource) {
    output.addAudioTrack(audioSource);
  }

  await output.start();
  const cancel = () => void output.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  let decodedSampleCount = 0;
  let waveformSampleCount = 0;
  let lastAudioProgressSec = -Infinity;
  let lastVideoProgressSec = -Infinity;
  const shouldReport = (timestampSec: number, previous: number) =>
    timestampSec === 0 ||
    timestampSec >= durationSec - 1 / parameters.frameRate ||
    timestampSec - previous >= 0.5;

  try {
    const videoPump = async () => {
      const sink = new VideoSampleSink(tracks.video);
      for await (const sample of sink.samples(0, durationSec)) {
        signal?.throwIfAborted();
        try {
          sample.setTimestamp(Math.max(0, sample.timestamp));
          await videoSource.add(sample);
          if (shouldReport(sample.timestamp, lastVideoProgressSec)) {
            lastVideoProgressSec = sample.timestamp;
            report("transcode", {
              durationSec,
              outputBytes,
              processedTimeSec: sample.timestamp,
            });
          }
        } finally {
          sample.close();
        }
      }
      videoSource.close();
    };

    const audioPump = async () => {
      if (!tracks.audio || !audioSource) {
        return;
      }
      const sink = new AudioSampleSink(tracks.audio);
      for await (const decoded of sink.samples(0, durationSec)) {
        signal?.throwIfAborted();
        const sample = trimAudioSample(decoded, durationSec);
        if (!sample) {
          decoded.close();
          continue;
        }
        if (sample !== decoded) {
          decoded.close();
        }
        try {
          sample.setTimestamp(Math.max(0, sample.timestamp));
          const pcm = monoPcm(sample);
          decodedSampleCount += pcm.length;
          const remainingWaveformSamples =
            expectedWaveformSamples - waveformSampleCount;
          if (remainingWaveformSamples > 0) {
            const waveformPcm =
              pcm.length > remainingWaveformSamples
                ? pcm.subarray(0, remainingWaveformSamples)
                : pcm;
            waveform.push(waveformPcm);
            waveformSampleCount += waveformPcm.length;
          }
          if (shouldReport(sample.timestamp, lastAudioProgressSec)) {
            lastAudioProgressSec = sample.timestamp;
            report("waveform", {
              durationSec,
              outputBytes,
              processedTimeSec: sample.timestamp,
            });
          }
          await audioSource.add(sample);
        } finally {
          sample.close();
        }
      }
      audioSource.close();
    };

    await Promise.all([videoPump(), audioPump()]);
    signal?.throwIfAborted();
    await output.finalize();
    return { decodedSampleCount, keyframes, outputBytes, waveformSampleCount };
  } catch (error) {
    if (output.state !== "canceled" && output.state !== "finalized") {
      await output.cancel();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!input.disposed) {
      input.dispose();
    }
  }
}

function waveformExtrema(
  data: Float32Array,
  bucketCount: number,
): {
  maxValue: number;
  minValue: number;
  rmsMax: number;
} {
  const minima = data.subarray(0, bucketCount);
  const maxima = data.subarray(bucketCount, bucketCount * 2);
  const rms = data.subarray(bucketCount * 2);
  return {
    maxValue: maxima.reduce((value, sample) => Math.max(value, sample), -1),
    minValue: minima.reduce((value, sample) => Math.min(value, sample), 1),
    rmsMax: rms.reduce((value, sample) => Math.max(value, sample), 0),
  };
}

function progressStatsFields(
  stats: ProxyCacheStats | undefined,
): Partial<MediaProxyProgress> {
  if (!stats) {
    return {};
  }
  return {
    cacheAdapter: stats.adapter,
    cacheEntries: stats.entries,
    committedBytes: stats.committedBytes,
    storageEstimate: stats.storageEstimate,
    temporaryBytes: stats.temporaryBytes,
    temporaryEntries: stats.temporaryEntries,
  };
}

export async function generateMediaProxy(
  options: GenerateMediaProxyOptions,
): Promise<MediaProxyResult> {
  const startedAt = performance.now();
  let cacheKey: string | undefined;
  let parameters: ProxyGenerationParameters | undefined;
  let latestStats: ProxyCacheStats | undefined;
  let lastStatsSampleAt = Number.NEGATIVE_INFINITY;
  let statsSample: Promise<void> | undefined;
  const report = (
    stage: MediaProxyProgress["stage"],
    fields: Partial<MediaProxyProgress> = {},
  ) => {
    const now = performance.now();
    if (
      !statsSample &&
      now - lastStatsSampleAt >= PROGRESS_STATS_SAMPLE_INTERVAL_MS
    ) {
      lastStatsSampleAt = now;
      statsSample = options.cache
        .stats()
        .then((stats) => {
          latestStats = stats;
        })
        .catch((error: unknown) => {
          options.logger?.log({
            error,
            event: "generation.progress",
            input: { cacheKey, fingerprint: options.fingerprint },
            level: "warn",
            marker: "[PROXY]",
            output: { storageEstimate: { available: false } },
            requestId: options.requestId,
          });
        })
        .finally(() => {
          statsSample = undefined;
        });
    }
    const progress = {
      elapsedMs: now - startedAt,
      stage,
      ...progressStatsFields(latestStats),
      ...fields,
    } satisfies MediaProxyProgress;
    options.onProgress?.(progress);
    options.logger?.log({
      event: "generation.progress",
      input: { cacheKey, fingerprint: options.fingerprint },
      level: "debug",
      marker: "[PROXY]",
      output: progress,
      requestId: options.requestId,
    });
  };

  const input = new Input({
    formats: ALL_FORMATS,
    source: browserSource(options.source),
  });
  let transaction: ProxyCacheTransaction | undefined;
  let waveform: PcmWaveformSession | undefined;

  try {
    options.signal?.throwIfAborted();
    const tracks = await primaryTracks(input);
    const [inputWidth, inputHeight, metadataDuration, audioSampleRate] =
      await Promise.all([
        tracks.video.getDisplayWidth(),
        tracks.video.getDisplayHeight(),
        input.getDurationFromMetadata(
          tracks.audio ? [tracks.video, tracks.audio] : [tracks.video],
        ),
        tracks.audio?.getSampleRate() ?? Promise.resolve(0),
      ]);
    const fullDuration =
      metadataDuration ??
      (await input.computeDuration(
        tracks.audio ? [tracks.video, tracks.audio] : [tracks.video],
      ));
    parameters = resolveProxyParameters(options.parameters, fullDuration);
    cacheKey = await createProxyCacheKey(options.fingerprint, parameters);
    const durationSec = effectiveDuration(fullDuration, parameters);
    const dimensions = calculateProxyDimensions(
      inputWidth,
      inputHeight,
      parameters,
    );
    report("cache", {
      durationSec,
      inputHeight,
      inputWidth,
      outputHeight: dimensions.height,
      outputWidth: dimensions.width,
    });
    const cached = await options.cache.get(cacheKey);
    if (cached) {
      const stats = await options.cache.stats();
      latestStats = stats;
      options.logger?.log({
        event: "cache.hit",
        input: { cacheKey, fingerprint: options.fingerprint, parameters },
        level: "info",
        marker: "[PROXY]",
        output: stats,
        requestId: options.requestId,
      });
      report("completed", {
        cacheStatus: "hit",
        durationSec: cached.proxy.durationSec,
        inputHeight: cached.source.height,
        inputWidth: cached.source.width,
        outputBytes: cached.proxy.byteLength,
        outputHeight: cached.proxy.height,
        outputWidth: cached.proxy.width,
        pcmSampleCount: cached.diagnostics?.pcmSampleCount,
        processedTimeSec: cached.proxy.durationSec,
      });
      return {
        cache: { ...stats, key: cacheKey, status: "hit" },
        elapsedMs: performance.now() - startedAt,
        manifest: cached,
      };
    }

    options.logger?.log({
      event: "cache.miss",
      input: { cacheKey, fingerprint: options.fingerprint, parameters },
      level: "info",
      marker: "[PROXY]",
      requestId: options.requestId,
    });
    transaction = await options.cache.begin(cacheKey);
    options.logger?.log({
      event: "generation.started",
      input: {
        cacheKey,
        durationSec,
        fingerprint: options.fingerprint,
        height: inputHeight,
        parameters,
        width: inputWidth,
      },
      level: "info",
      marker: "[PROXY]",
      output: dimensions,
      requestId: options.requestId,
    });

    report("thumbnails", {
      durationSec,
      inputHeight,
      inputWidth,
      outputHeight: dimensions.height,
      outputWidth: dimensions.width,
    });
    const images = await createImages(
      tracks.video,
      durationSec,
      parameters,
      dimensions,
      transaction,
      report,
      options.signal,
    );
    const wasm =
      options.wasm ??
      (await initMediaWasm({
        logger: options.logger,
        requestId: options.requestId,
      }));
    const expectedSamples = tracks.audio
      ? Math.round(durationSec * audioSampleRate)
      : 0;
    waveform = wasm.createWaveform(expectedSamples, parameters.waveformBuckets);
    const encoded = await transcode(
      input,
      tracks,
      durationSec,
      dimensions,
      parameters,
      transaction,
      waveform,
      expectedSamples,
      report,
      options.signal,
    );
    report("keyframes", {
      durationSec,
      outputBytes: encoded.outputBytes,
      processedTimeSec: durationSec,
    });
    const pcmDiagnostics = pcmSampleCountDiagnostics(
      expectedSamples,
      encoded.decodedSampleCount,
      audioSampleRate,
    );
    if (pcmDiagnostics?.strategy === "fail") {
      options.logger?.log({
        event: "generation.failed",
        input: { cacheKey, fingerprint: options.fingerprint, parameters },
        level: "error",
        marker: "[PROXY]",
        output: { pcmSampleCount: pcmDiagnostics },
        requestId: options.requestId,
      });
      throw new PcmSampleCountMismatchError(pcmDiagnostics);
    }
    if (pcmDiagnostics?.strategy === "pad-silence") {
      const missingSamples = expectedSamples - encoded.waveformSampleCount;
      if (missingSamples > 0) {
        waveform.push(new Float32Array(missingSamples));
        encoded.waveformSampleCount += missingSamples;
      }
    }
    if (pcmDiagnostics) {
      options.logger?.log({
        event: "generation.progress",
        input: { cacheKey, fingerprint: options.fingerprint, parameters },
        level: "warn",
        marker: "[PROXY]",
        output: { pcmSampleCount: pcmDiagnostics },
        requestId: options.requestId,
      });
      report("waveform", {
        durationSec,
        outputBytes: encoded.outputBytes,
        pcmSampleCount: pcmDiagnostics,
        processedTimeSec: durationSec,
      });
    }
    const waveformResult = waveform.finish();
    await transaction.write("waveform.f32", waveformResult.data);
    const extrema = waveformExtrema(
      waveformResult.data,
      waveformResult.bucketCount,
    );
    const manifest: ProxyManifest = {
      cacheKey,
      cover: images.cover,
      createdAt: new Date().toISOString(),
      diagnostics: pcmDiagnostics
        ? { pcmSampleCount: pcmDiagnostics }
        : undefined,
      fingerprint: options.fingerprint,
      keyframes: encoded.keyframes,
      parameters,
      proxy: {
        byteLength: encoded.outputBytes,
        durationSec,
        frameRate: parameters.frameRate,
        height: dimensions.height,
        mimeType: "video/mp4",
        path: "proxy.mp4",
        width: dimensions.width,
      },
      source: {
        durationSec: fullDuration,
        height: inputHeight,
        width: inputWidth,
      },
      thumbnails: images.thumbnails,
      version: MEDIA_PROXY_RESULT_VERSION,
      waveform: {
        bucketCount: waveformResult.bucketCount,
        byteLength: waveformResult.data.byteLength,
        maxValue: extrema.maxValue,
        mimeType: "application/x-float32",
        minValue: extrema.minValue,
        path: "waveform.f32",
        rmsMax: extrema.rmsMax,
        sampleCount: waveformResult.sampleCount,
      },
    };

    report("commit", { durationSec, outputBytes: encoded.outputBytes });
    await transaction.commit(manifest);
    const stats = await options.cache.stats();
    latestStats = stats;
    const elapsedMs = performance.now() - startedAt;
    options.logger?.log({
      durationMs: elapsedMs,
      event: "generation.completed",
      input: { cacheKey, fingerprint: options.fingerprint, parameters },
      level: "info",
      marker: "[PROXY]",
      output: { manifest, stats },
      requestId: options.requestId,
    });
    report("completed", {
      cacheStatus: "miss",
      durationSec,
      inputHeight,
      inputWidth,
      outputBytes: encoded.outputBytes,
      outputHeight: dimensions.height,
      outputWidth: dimensions.width,
      pcmSampleCount: pcmDiagnostics,
      processedTimeSec: durationSec,
    });
    return {
      cache: { ...stats, key: cacheKey, status: "miss" },
      elapsedMs,
      manifest,
    };
  } catch (error) {
    if (transaction) {
      await transaction.abort();
    }
    const cancelled = options.signal?.aborted === true;
    options.logger?.log({
      durationMs: performance.now() - startedAt,
      error,
      event: cancelled ? "generation.cancelled" : "generation.failed",
      input: { cacheKey, fingerprint: options.fingerprint, parameters },
      level: cancelled ? "warn" : "error",
      marker: "[PROXY]",
      output: await options.cache.stats(),
      requestId: options.requestId,
    });
    throw error;
  } finally {
    waveform?.dispose();
    if (!input.disposed) {
      input.dispose();
    }
  }
}
