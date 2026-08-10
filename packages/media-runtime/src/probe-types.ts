export const MEDIA_PROBE_OPERATION = "media.probe" as const;
export const MEDIA_PROBE_RESULT_VERSION = 1 as const;

export type BrowserMediaSource =
  | {
      kind: "blob" | "file";
      blob: Blob;
      name: string;
      lastModified?: number;
    }
  | {
      kind: "test-asset" | "url";
      name: string;
      url: string;
    };

export type MediaProbeRequest = {
  source: BrowserMediaSource;
};

export type MediaProbeProgress = {
  bytesRead: number;
  fileSize: number;
  heap: import("./runtime-metrics").JsHeapMetrics;
  heapBytes?: number;
  stage: "metadata" | "tracks" | "fingerprint" | "completed";
};

export type MediaReadMetrics = {
  adapter: "BlobSource" | "CustomSource" | "UrlSource";
  bytesRead: number;
  fileSize: number;
  fullFileRead: boolean;
  largestReadBytes: number;
  mode: "on-demand";
  readCalls: number;
  readRatio: number;
  uniqueBytesRead: number;
};

export type TrackDispositionSummary = {
  commentary: boolean;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  original: boolean;
  primary: boolean;
  visuallyImpaired: boolean;
};

export type KeyframeMetadata = {
  byteLength: number;
  durationSec: number;
  timestampSec: number;
  type: "key";
};

export type VideoTrackMetadata = {
  averageBitrate: number | null;
  codec: string | null;
  codecParameterString: string | null;
  codedHeight: number;
  codedWidth: number;
  decodable: boolean;
  displayHeight: number;
  displayWidth: number;
  disposition: TrackDispositionSummary;
  durationSec: number;
  firstKeyframe: KeyframeMetadata | null;
  frameRate: number;
  hasOnlyKeyframes: boolean;
  internalCodecId: string | number | null;
  language: string;
  name: string | null;
  number: number;
  packetCount: number;
  profile: string | null;
  rotation: number;
  trackId: number;
};

export type AudioTrackMetadata = {
  averageBitrate: number | null;
  channels: number;
  codec: string | null;
  codecParameterString: string | null;
  decodable: boolean;
  disposition: TrackDispositionSummary;
  durationSec: number;
  internalCodecId: string | number | null;
  language: string;
  name: string | null;
  number: number;
  profile: string | null;
  sampleRate: number;
  trackId: number;
};

export type ExcludedVideoTrack = {
  codec: string;
  id: string;
  reason: "jpeg-cover-art" | "mjpeg-additional-track";
  source: "metadata-image" | "video-track";
};

export type MediaProbeResult = {
  version: typeof MEDIA_PROBE_RESULT_VERSION;
  audioTracks: AudioTrackMetadata[];
  container: {
    format: string;
    mimeType: string;
  };
  durationSec: number;
  excludedVideoTracks: ExcludedVideoTrack[];
  fingerprint: string;
  primaryAudioTrackId: number | null;
  primaryVideoTrackId: number;
  read: MediaReadMetrics;
  source: {
    kind: BrowserMediaSource["kind"] | "path";
    lastModified?: number;
    name: string;
    size: number;
  };
  videoTracks: VideoTrackMetadata[];
};
