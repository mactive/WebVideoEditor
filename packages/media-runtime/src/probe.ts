import type { Asset } from "@web-video-editor/domain";
import type { StructuredLogger } from "@web-video-editor/observability";
import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  type Source,
  UrlSource,
} from "mediabunny";

import {
  MEDIA_PROBE_RESULT_VERSION,
  type AudioTrackMetadata,
  type BrowserMediaSource,
  type ExcludedVideoTrack,
  type MediaProbeProgress,
  type MediaProbeResult,
  type MediaReadMetrics,
  type TrackDispositionSummary,
  type VideoTrackMetadata,
} from "./probe-types";
import { sampleJsHeapMetrics } from "./runtime-metrics";

type ByteRange = {
  end: number;
  start: number;
};

export type ProbeSourceInfo = {
  kind: BrowserMediaSource["kind"] | "path";
  lastModified?: number;
  name: string;
};

export type ProbeMediaOptions = {
  logger?: StructuredLogger;
  onProgress?: (progress: MediaProbeProgress) => void;
  requestId?: string;
  signal?: AbortSignal;
};

export class MediaReadTracker {
  private readonly ranges: ByteRange[] = [];
  private bytesRead = 0;
  private largestReadBytes = 0;
  private readCalls = 0;

  constructor(
    private readonly adapter: MediaReadMetrics["adapter"] = "CustomSource",
  ) {}

  record(start: number, end: number): void {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      return;
    }
    const length = end - start;
    this.bytesRead += length;
    this.largestReadBytes = Math.max(this.largestReadBytes, length);
    this.readCalls += 1;
    this.ranges.push({ start, end });
  }

  snapshot(fileSize: number): MediaReadMetrics {
    const ranges = [...this.ranges].sort(
      (left, right) => left.start - right.start,
    );
    let uniqueBytesRead = 0;
    let current: ByteRange | undefined;
    for (const range of ranges) {
      if (!current || range.start > current.end) {
        uniqueBytesRead += range.end - range.start;
        current = { ...range };
      } else if (range.end > current.end) {
        uniqueBytesRead += range.end - current.end;
        current.end = range.end;
      }
    }

    return {
      adapter: this.adapter,
      bytesRead: this.bytesRead,
      fileSize,
      fullFileRead: fileSize > 0 && uniqueBytesRead >= fileSize,
      largestReadBytes: this.largestReadBytes,
      mode: "on-demand",
      readCalls: this.readCalls,
      readRatio: fileSize > 0 ? Math.min(uniqueBytesRead / fileSize, 1) : 0,
      uniqueBytesRead,
    };
  }
}

function internalCodecId(
  value: string | number | Uint8Array<ArrayBufferLike> | null,
): string | number | null {
  if (!(value instanceof Uint8Array)) {
    return value;
  }
  return `0x${Array.from(value.subarray(0, 32), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function codecProfile(
  codec: string | null,
  parameter: string | null,
): string | null {
  if (codec === "avc" && parameter) {
    const match = /^(?:avc1|avc3)\.([0-9a-fA-F]{2})/.exec(parameter);
    const profileIdc = match?.[1]?.toLowerCase();
    return (
      {
        "42": "Baseline",
        "4d": "Main",
        "58": "Extended",
        "64": "High",
        "6e": "High 10",
        "7a": "High 4:2:2",
        f4: "High 4:4:4",
      }[profileIdc ?? ""] ?? null
    );
  }
  if (codec === "aac" && parameter?.endsWith(".2")) {
    return "LC";
  }
  return null;
}

async function canDecode(
  track: InputAudioTrack | InputVideoTrack,
): Promise<boolean> {
  try {
    return await track.canDecode();
  } catch {
    return false;
  }
}

async function summarizeVideoTrack(
  track: InputVideoTrack,
): Promise<VideoTrackMetadata> {
  const sink = new EncodedPacketSink(track);
  const [
    codec,
    codecParameterString,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    durationSec,
    disposition,
    averageBitrate,
    packetStats,
    firstKeyframe,
    hasOnlyKeyframes,
    language,
    name,
    rawInternalCodecId,
    decodable,
  ] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getCodedWidth(),
    track.getCodedHeight(),
    track.getDisplayWidth(),
    track.getDisplayHeight(),
    track.getRotation(),
    track.getDurationFromMetadata(),
    track.getDisposition(),
    track.getAverageBitrate(),
    track.computePacketStats(120, { metadataOnly: true }),
    sink.getFirstKeyPacket({ metadataOnly: true }),
    track.hasOnlyKeyPackets(),
    track.getLanguageCode(),
    track.getName(),
    track.getInternalCodecId(),
    canDecode(track),
  ]);

  return {
    averageBitrate,
    codec,
    codecParameterString,
    codedHeight,
    codedWidth,
    decodable,
    displayHeight,
    displayWidth,
    disposition: disposition as TrackDispositionSummary,
    durationSec: durationSec ?? 0,
    firstKeyframe: firstKeyframe
      ? {
          byteLength: firstKeyframe.byteLength,
          durationSec: firstKeyframe.duration,
          timestampSec: Math.max(firstKeyframe.timestamp, 0),
          type: "key",
        }
      : null,
    frameRate: packetStats.averagePacketRate,
    hasOnlyKeyframes,
    internalCodecId: internalCodecId(rawInternalCodecId),
    language,
    name,
    number: track.number,
    packetCount: packetStats.packetCount,
    profile: codecProfile(codec, codecParameterString),
    rotation,
    trackId: track.id,
  };
}

async function summarizeAudioTrack(
  track: InputAudioTrack,
): Promise<AudioTrackMetadata> {
  const [
    codec,
    codecParameterString,
    channels,
    sampleRate,
    durationSec,
    disposition,
    averageBitrate,
    language,
    name,
    rawInternalCodecId,
    decodable,
  ] = await Promise.all([
    track.getCodec(),
    track.getCodecParameterString(),
    track.getNumberOfChannels(),
    track.getSampleRate(),
    track.getDurationFromMetadata(),
    track.getDisposition(),
    track.getAverageBitrate(),
    track.getLanguageCode(),
    track.getName(),
    track.getInternalCodecId(),
    canDecode(track),
  ]);

  return {
    averageBitrate,
    channels,
    codec,
    codecParameterString,
    decodable,
    disposition: disposition as TrackDispositionSummary,
    durationSec: durationSec ?? 0,
    internalCodecId: internalCodecId(rawInternalCodecId),
    language,
    name,
    number: track.number,
    profile: codecProfile(codec, codecParameterString),
    sampleRate,
    trackId: track.id,
  };
}

function compareVideoTracks(
  left: VideoTrackMetadata,
  right: VideoTrackMetadata,
): number {
  const leftRank = [
    Number(left.frameRate >= 1 && left.packetCount > 1),
    Number(left.disposition.primary),
    Number(left.disposition.default),
    left.packetCount,
    left.displayWidth * left.displayHeight,
    left.durationSec,
    left.averageBitrate ?? 0,
    -left.number,
  ];
  const rightRank = [
    Number(right.frameRate >= 1 && right.packetCount > 1),
    Number(right.disposition.primary),
    Number(right.disposition.default),
    right.packetCount,
    right.displayWidth * right.displayHeight,
    right.durationSec,
    right.averageBitrate ?? 0,
    -right.number,
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = (rightRank[index] ?? 0) - (leftRank[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function selectPrimaryVideoTrack(
  tracks: readonly VideoTrackMetadata[],
): {
  excluded: ExcludedVideoTrack[];
  primary: VideoTrackMetadata;
} {
  if (tracks.length === 0) {
    throw new Error("Media contains no video track");
  }
  const hasNonMjpeg = tracks.some((track) => track.codec !== "mjpeg");
  const excluded = hasNonMjpeg
    ? tracks
        .filter((track) => track.codec === "mjpeg")
        .map((track): ExcludedVideoTrack => ({
          codec: "mjpeg",
          id: String(track.trackId),
          reason: "mjpeg-additional-track",
          source: "video-track",
        }))
    : [];
  const candidates = tracks.filter(
    (track) => !excluded.some((item) => item.id === String(track.trackId)),
  );
  const primary = [...candidates].sort(compareVideoTracks)[0];
  if (!primary) {
    throw new Error("Media contains no usable video track");
  }
  return { excluded, primary };
}

async function sha256Fingerprint(
  fileSize: number,
  durationSec: number,
  video: VideoTrackMetadata,
  audio: AudioTrackMetadata | undefined,
  keyframeBytes: Uint8Array,
): Promise<string> {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      audio: audio
        ? {
            channels: audio.channels,
            codec: audio.codec,
            codecParameterString: audio.codecParameterString,
            sampleRate: audio.sampleRate,
          }
        : null,
      durationUs: Math.round(durationSec * 1_000_000),
      fileSize,
      video: {
        codec: video.codec,
        codecParameterString: video.codecParameterString,
        frameRate: video.frameRate,
        height: video.displayHeight,
        rotation: video.rotation,
        width: video.displayWidth,
      },
    }),
  );
  const bytes = new Uint8Array(metadata.byteLength + keyframeBytes.byteLength);
  bytes.set(metadata);
  bytes.set(keyframeBytes, metadata.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function formatName(input: Input): Promise<string> {
  return input.getFormat().then((format) =>
    format.constructor.name
      .replace(/InputFormat$/, "")
      .replace(/([a-z])([A-Z])/g, "$1-$2")
      .toLowerCase(),
  );
}

function attachReadTracking(source: Source, tracker: MediaReadTracker): void {
  source.on("read", ({ start, end }) => tracker.record(start, end));
}

export async function probeMediaSource(
  source: Source,
  sourceInfo: ProbeSourceInfo,
  tracker = new MediaReadTracker(),
  options: ProbeMediaOptions = {},
): Promise<MediaProbeResult> {
  attachReadTracking(source, tracker);
  const input = new Input({ formats: ALL_FORMATS, source });
  const startedAt = performance.now();
  const requestId = options.requestId;
  const abort = () => input.dispose();
  options.signal?.addEventListener("abort", abort, { once: true });

  const report = (
    stage: MediaProbeProgress["stage"],
    fileSize: number,
  ): void => {
    const read = tracker.snapshot(fileSize);
    const heap = sampleJsHeapMetrics();
    const progress: MediaProbeProgress = {
      bytesRead: read.uniqueBytesRead,
      fileSize,
      heap,
      ...(heap.usedJSHeapSize === undefined
        ? {}
        : { heapBytes: heap.usedJSHeapSize }),
      stage,
    };
    options.onProgress?.(progress);
    options.logger?.log({
      event: "progress",
      input: { fileSize, name: sourceInfo.name },
      level: "debug",
      marker: "[IMPORT]",
      output: progress,
      requestId,
    });
  };

  options.logger?.log({
    event: "probe.started",
    input: { kind: sourceInfo.kind, name: sourceInfo.name },
    level: "info",
    marker: "[IMPORT]",
    requestId,
  });

  try {
    options.signal?.throwIfAborted();
    const fileSize = await source.getSize();
    const [containerFormat, mimeType, inputVideoTracks, inputAudioTracks] =
      await Promise.all([
        formatName(input),
        input.getMimeType(),
        input.getVideoTracks(),
        input.getAudioTracks(),
      ]);
    report("metadata", fileSize);

    const [videoTracks, audioTracks, metadataTags] = await Promise.all([
      Promise.all(inputVideoTracks.map(summarizeVideoTrack)),
      Promise.all(inputAudioTracks.map(summarizeAudioTrack)),
      input.getMetadataTags(),
    ]);
    const selection = selectPrimaryVideoTrack(videoTracks);
    const primaryVideoInput = inputVideoTracks.find(
      (track) => track.id === selection.primary.trackId,
    );
    if (!primaryVideoInput) {
      throw new Error("Selected video track is unavailable");
    }
    const pairableAudio =
      (await primaryVideoInput.getPrimaryPairableAudioTrack()) ??
      (await input.getPrimaryAudioTrack());
    const primaryAudio = pairableAudio
      ? audioTracks.find((track) => track.trackId === pairableAudio.id)
      : undefined;
    const primaryTracks = pairableAudio
      ? [primaryVideoInput, pairableAudio]
      : [primaryVideoInput];
    const durationSec =
      (await input.getDurationFromMetadata(primaryTracks)) ??
      (await input.computeDuration(primaryTracks));
    report("tracks", fileSize);

    const keyframe = await new EncodedPacketSink(
      primaryVideoInput,
    ).getFirstKeyPacket();
    const fingerprint = await sha256Fingerprint(
      fileSize,
      durationSec,
      selection.primary,
      primaryAudio,
      keyframe?.data ?? new Uint8Array(),
    );
    report("fingerprint", fileSize);

    const coverExclusions: ExcludedVideoTrack[] = (metadataTags.images ?? [])
      .filter((image) => image.mimeType === "image/jpeg")
      .map((_, index) => ({
        codec: "mjpeg",
        id: `cover:${index}`,
        reason: "jpeg-cover-art",
        source: "metadata-image",
      }));
    const result: MediaProbeResult = {
      version: MEDIA_PROBE_RESULT_VERSION,
      audioTracks,
      container: {
        format: containerFormat,
        mimeType,
      },
      durationSec,
      excludedVideoTracks: [...selection.excluded, ...coverExclusions],
      fingerprint,
      primaryAudioTrackId: primaryAudio?.trackId ?? null,
      primaryVideoTrackId: selection.primary.trackId,
      read: tracker.snapshot(fileSize),
      source: {
        kind: sourceInfo.kind,
        lastModified: sourceInfo.lastModified,
        name: sourceInfo.name,
        size: fileSize,
      },
      videoTracks,
    };
    report("completed", fileSize);
    options.logger?.log({
      durationMs: performance.now() - startedAt,
      event: "probe.completed",
      input: { kind: sourceInfo.kind, name: sourceInfo.name, size: fileSize },
      level: "info",
      marker: "[IMPORT]",
      output: {
        durationSec,
        fingerprint,
        primaryAudioTrackId: result.primaryAudioTrackId,
        primaryVideoTrackId: result.primaryVideoTrackId,
        read: result.read,
      },
      requestId,
    });
    return result;
  } catch (error) {
    options.logger?.log({
      durationMs: performance.now() - startedAt,
      error,
      event: options.signal?.aborted ? "cancelled" : "failed",
      input: { kind: sourceInfo.kind, name: sourceInfo.name },
      level: options.signal?.aborted ? "warn" : "error",
      marker: "[IMPORT]",
      requestId,
    });
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (!input.disposed) {
      input.dispose();
    }
  }
}

export async function probeBrowserMedia(
  descriptor: BrowserMediaSource,
  options: ProbeMediaOptions = {},
): Promise<MediaProbeResult> {
  const tracker = new MediaReadTracker(
    "blob" in descriptor ? "BlobSource" : "UrlSource",
  );
  let source: Source;
  if ("blob" in descriptor) {
    source = new BlobSource(descriptor.blob, {
      maxCacheSize: 8 * 1024 * 1024,
    });
  } else {
    source = new UrlSource(descriptor.url, {
      maxCacheSize: 8 * 1024 * 1024,
      parallelism: 2,
    });
  }

  return probeMediaSource(
    source,
    {
      kind: descriptor.kind,
      lastModified:
        "lastModified" in descriptor ? descriptor.lastModified : undefined,
      name: descriptor.name,
    },
    tracker,
    options,
  );
}

function requiredPrimaryVideo(result: MediaProbeResult): VideoTrackMetadata {
  const video = result.videoTracks.find(
    (track) => track.trackId === result.primaryVideoTrackId,
  );
  if (!video) {
    throw new Error("Probe result is missing its primary video track");
  }
  return video;
}

export function mediaProbeToProjectAsset(
  result: MediaProbeResult,
  id = `asset-${result.fingerprint.slice(-16)}`,
): Asset {
  const video = requiredPrimaryVideo(result);
  const audio = result.audioTracks.find(
    (track) => track.trackId === result.primaryAudioTrackId,
  );
  return {
    id,
    name: result.source.name,
    fingerprint: result.fingerprint,
    durationUs: Math.max(1, Math.round(result.durationSec * 1_000_000)),
    width: video.displayWidth,
    height: video.displayHeight,
    frameRate: video.frameRate,
    hasAudio: audio !== undefined,
    media: {
      container: result.container.format,
      mimeType: result.container.mimeType,
      rotation: video.rotation,
      firstKeyframeUs: video.firstKeyframe
        ? Math.round(video.firstKeyframe.timestampSec * 1_000_000)
        : null,
      video: {
        trackId: video.trackId,
        codec: video.codec ?? "unknown",
        codecParameterString: video.codecParameterString,
        profile: video.profile,
      },
      audio: audio
        ? {
            trackId: audio.trackId,
            codec: audio.codec ?? "unknown",
            codecParameterString: audio.codecParameterString,
            profile: audio.profile,
            sampleRate: audio.sampleRate,
            channels: audio.channels,
          }
        : null,
      excludedVideoTracks: result.excludedVideoTracks.map((track) => ({
        id: track.id,
        codec: track.codec,
        reason: track.reason,
      })),
    },
    source: {
      kind: result.source.kind === "path" ? "file" : result.source.kind,
      name: result.source.name,
      size: result.source.size,
      ...(result.source.lastModified === undefined
        ? {}
        : { lastModified: result.source.lastModified }),
    },
  };
}
