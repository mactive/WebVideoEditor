export const MEDIA_PROXY_OPERATION = "media.proxy.generate" as const;
export const MEDIA_PROXY_RESULT_VERSION = 1 as const;

export type ProxyGenerationParameters = {
  frameRate: number;
  keyFrameIntervalSec: number;
  maxDurationSec?: number;
  maxHeight: number;
  maxWidth: number;
  thumbnailIntervalSec: number;
  thumbnailWidth: number;
  waveformBuckets: number;
};

export const DEFAULT_PROXY_PARAMETERS: ProxyGenerationParameters = {
  frameRate: 30,
  keyFrameIntervalSec: 2,
  maxHeight: 540,
  maxWidth: 960,
  thumbnailIntervalSec: 5,
  thumbnailWidth: 160,
  waveformBuckets: 512,
};

export type ProxyArtifact = {
  byteLength: number;
  mimeType: string;
  path: string;
};

export type ProxyImageArtifact = ProxyArtifact & {
  height: number;
  timestampSec: number;
  width: number;
};

export type ProxyKeyframe = {
  byteLength: number;
  durationSec: number;
  sequenceNumber: number;
  timestampSec: number;
};

export type ProxyCacheStats = {
  adapter: "memory" | "opfs";
  committedBytes: number;
  entries: number;
  storageEstimate: import("./runtime-metrics").StorageEstimateMetrics;
  temporaryBytes: number;
  temporaryEntries: number;
};

export type ProxyCacheStatus = "hit" | "miss";

export type ProxyManifest = {
  cacheKey: string;
  cover: ProxyImageArtifact;
  createdAt: string;
  fingerprint: string;
  keyframes: ProxyKeyframe[];
  parameters: ProxyGenerationParameters;
  proxy: ProxyArtifact & {
    durationSec: number;
    frameRate: number;
    height: number;
    width: number;
  };
  source: {
    durationSec: number;
    height: number;
    width: number;
  };
  thumbnails: ProxyImageArtifact[];
  version: typeof MEDIA_PROXY_RESULT_VERSION;
  waveform: ProxyArtifact & {
    bucketCount: number;
    maxValue: number;
    minValue: number;
    rmsMax: number;
    sampleCount: number;
  };
};

export type MediaProxyRequest = {
  fingerprint: string;
  parameters?: Partial<ProxyGenerationParameters>;
};

export type MediaProxyProgress = {
  cacheStatus?: ProxyCacheStatus;
  elapsedMs: number;
  inputHeight?: number;
  inputWidth?: number;
  outputBytes?: number;
  outputHeight?: number;
  outputWidth?: number;
  processedTimeSec?: number;
  stage:
    | "cache"
    | "thumbnails"
    | "keyframes"
    | "transcode"
    | "waveform"
    | "commit"
    | "completed";
};

export type MediaProxyResult = {
  cache: ProxyCacheStats & {
    key: string;
    status: ProxyCacheStatus;
  };
  elapsedMs: number;
  manifest: ProxyManifest;
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

export function resolveProxyParameters(
  input: Partial<ProxyGenerationParameters> = {},
): ProxyGenerationParameters {
  const parameters = { ...DEFAULT_PROXY_PARAMETERS, ...input };
  positiveFinite(parameters.frameRate, "frameRate");
  positiveFinite(parameters.keyFrameIntervalSec, "keyFrameIntervalSec");
  positiveInteger(parameters.maxHeight, "maxHeight");
  positiveInteger(parameters.maxWidth, "maxWidth");
  positiveFinite(parameters.thumbnailIntervalSec, "thumbnailIntervalSec");
  positiveInteger(parameters.thumbnailWidth, "thumbnailWidth");
  positiveInteger(parameters.waveformBuckets, "waveformBuckets");
  if (parameters.maxDurationSec !== undefined) {
    positiveFinite(parameters.maxDurationSec, "maxDurationSec");
  }
  return parameters;
}

export function calculateProxyDimensions(
  inputWidth: number,
  inputHeight: number,
  parameters: Pick<ProxyGenerationParameters, "maxHeight" | "maxWidth">,
): { height: number; width: number } {
  positiveInteger(inputWidth, "inputWidth");
  positiveInteger(inputHeight, "inputHeight");
  const scale = Math.min(
    1,
    parameters.maxWidth / inputWidth,
    parameters.maxHeight / inputHeight,
  );
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  return {
    height: even(inputHeight * scale),
    width: even(inputWidth * scale),
  };
}
