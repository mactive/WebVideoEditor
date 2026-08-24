import type { Effect, ProjectDocument } from "@web-video-editor/domain";
import type {
  CodecQueueObservation,
  ProxyCacheStatus,
  ProxyKeyframe,
  ProxyManifest,
} from "@web-video-editor/media-runtime";

export type RuntimeEntityKind = "text" | "video";

export type TimelineComponent = {
  active: boolean;
  endUs: number;
  localTimeUs: number;
  sourceStartUs: number;
  startUs: number;
};

export type AnimationComponent = {
  opacity: number;
};

export type TransformComponent = {
  height: number;
  rotationRad: number;
  scaleX: number;
  scaleY: number;
  width: number;
  x: number;
  y: number;
};

export type NormalizedEffect =
  | {
      amount: number;
      id: string;
      kind: "grayscale" | "vintage";
    }
  | {
      brightness: number;
      contrast: number;
      id: string;
      kind: "adjustments";
    };

export type EffectComponent = {
  definitions: readonly Effect[];
  resolved: readonly NormalizedEffect[];
};

export type VideoComponent = {
  assetId: string;
  requestedSourceTimeUs: number;
};

export type TextComponent = {
  color: string;
  fontSize: number;
  value: string;
};

export type RenderComponent = {
  order: number;
  visible: boolean;
};

export type RuntimeEntity = {
  animation: AnimationComponent;
  effects: EffectComponent;
  id: string;
  kind: RuntimeEntityKind;
  render: RenderComponent;
  timeline: TimelineComponent;
  transform: TransformComponent;
  text?: TextComponent;
  video?: VideoComponent;
};

export type QualityProfile = {
  frameRate: number;
  height: number;
  kind: "export" | "preview";
  mediaSource: "original" | "proxy";
  width: number;
};

type PreviewSourceBase = {
  assetId: string;
  cacheStatus: ProxyCacheStatus;
  keyframes: readonly ProxyKeyframe[];
};

export type PreviewSource =
  | (PreviewSourceBase & {
      manifest: ProxyManifest;
      mediaUrl?: string;
    })
  | (PreviewSourceBase & {
      cacheKey: string;
      frameRate: number;
      height: number;
      mediaUrl: string;
      width: number;
    });

export function previewSourceMetadata(source: PreviewSource): {
  cacheKey: string;
  frameRate: number;
  height: number;
  width: number;
} {
  if ("manifest" in source) {
    return {
      cacheKey: source.manifest.cacheKey,
      frameRate: source.manifest.proxy.frameRate,
      height: source.manifest.proxy.height,
      width: source.manifest.proxy.width,
    };
  }
  return {
    cacheKey: source.cacheKey,
    frameRate: source.frameRate,
    height: source.height,
    width: source.width,
  };
}

export type RuntimeEvaluation = {
  activeEntities: readonly RuntimeEntity[];
  activeVideos: readonly {
    assetId: string;
    entityId: string;
    order: number;
    sourceTimeUs: number;
  }[];
  created: number;
  playheadUs: number;
  released: number;
  revision: number;
  updated: number;
  video?: {
    assetId: string;
    entityId: string;
    sourceTimeUs: number;
  };
};

export type PreviewMetrics = {
  activeResources: number;
  activeVideoLayers: number;
  audioActiveSources: number;
  audioGeneration: number;
  avDriftUs: number;
  cacheHitRate: number;
  clockSource: "audio" | "performance";
  clockTransportMode: "message" | "shared";
  codecQueues: {
    audioDecoder: CodecQueueObservation | null;
    videoDecoder: CodecQueueObservation;
  };
  decodeQueue: number;
  droppedFrames: number;
  fps: number;
  frameTimestampErrorUs: number;
  height: number;
  playheadUs: number;
  presentedPlayheadUs: number;
  presentedFrames: number;
  resyncs: number;
  staleFrames: number;
  timestampDrops: number;
  width: number;
};

export type PreviewRuntimeSnapshot = {
  buffering: boolean;
  durationUs: number;
  error?: string;
  metrics: PreviewMetrics;
  playing: boolean;
  ready: boolean;
};

export type RuntimeProject = Pick<
  ProjectDocument,
  "canvas" | "clips" | "exportSettings" | "revision" | "texts" | "tracks"
>;
