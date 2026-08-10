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
  type ProxyGenerationParameters,
  type ProxyImageArtifact,
  type ProxyKeyframe,
  type ProxyManifest,
} from "./proxy-types";

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

function timestampSeries(durationSec: number, intervalSec: number): number[] {
  const timestamps = [0];
  for (
    let timestamp = intervalSec;
    timestamp < durationSec;
    timestamp += intervalSec
  ) {
    timestamps.push(timestamp);
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

async function transcode(
  input: Input,
  tracks: PrimaryTracks,
  durationSec: number,
  dimensions: { height: number; width: number },
  parameters: ProxyGenerationParameters,
  transaction: ProxyCacheTransaction,
  waveform: PcmWaveformSession,
  report: (stage: MediaProxyProgress["stage"], fields?: object) => void,
  signal?: AbortSignal,
): Promise<{
  keyframes: ProxyKeyframe[];
  outputBytes: number;
  sampleCount: number;
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
  let sampleCount = 0;
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
          waveform.push(pcm);
          sampleCount += pcm.length;
          if (shouldReport(sample.timestamp, lastAudioProgressSec)) {
            lastAudioProgressSec = sample.timestamp;
            report("waveform", {
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
    return { keyframes, outputBytes, sampleCount };
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

export async function generateMediaProxy(
  options: GenerateMediaProxyOptions,
): Promise<MediaProxyResult> {
  const startedAt = performance.now();
  const parameters = resolveProxyParameters(options.parameters);
  const cacheKey = await createProxyCacheKey(options.fingerprint, parameters);
  const report = (
    stage: MediaProxyProgress["stage"],
    fields: Partial<MediaProxyProgress> = {},
  ) => {
    const progress = {
      elapsedMs: performance.now() - startedAt,
      stage,
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

  report("cache");
  const cached = await options.cache.get(cacheKey);
  if (cached) {
    const stats = await options.cache.stats();
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
      inputHeight: cached.source.height,
      inputWidth: cached.source.width,
      outputBytes: cached.proxy.byteLength,
      outputHeight: cached.proxy.height,
      outputWidth: cached.proxy.width,
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
  const transaction = await options.cache.begin(cacheKey);
  const input = new Input({
    formats: ALL_FORMATS,
    source: browserSource(options.source),
  });
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
    const durationSec = effectiveDuration(fullDuration, parameters);
    const dimensions = calculateProxyDimensions(
      inputWidth,
      inputHeight,
      parameters,
    );
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
      report,
      options.signal,
    );
    report("keyframes", {
      outputBytes: encoded.outputBytes,
      processedTimeSec: durationSec,
    });
    if (encoded.sampleCount !== expectedSamples) {
      throw new Error(
        `Decoded PCM sample count mismatch: expected ${expectedSamples}, received ${encoded.sampleCount}`,
      );
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

    report("commit", { outputBytes: encoded.outputBytes });
    await transaction.commit(manifest);
    const stats = await options.cache.stats();
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
      inputHeight,
      inputWidth,
      outputBytes: encoded.outputBytes,
      outputHeight: dimensions.height,
      outputWidth: dimensions.width,
    });
    return {
      cache: { ...stats, key: cacheKey, status: "miss" },
      elapsedMs,
      manifest,
    };
  } catch (error) {
    if (!input.disposed) {
      input.dispose();
    }
    await transaction.abort();
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
  }
}
