import type { ProjectDocument } from "@web-video-editor/domain";
import {
  MediabunnyDecoderQueueAdapter,
  ResourceLifecycleTracker,
  sampleJsHeapMetrics,
  type BrowserMediaSource,
  type ResourceLease,
} from "@web-video-editor/media-runtime";
import type { StructuredLogger } from "@web-video-editor/observability";
import {
  ProjectRuntimeAdapter,
  type NormalizedEffect,
  type RuntimeEntity,
} from "@web-video-editor/preview-runtime";
import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  type AudioSample,
  type InputAudioTrack,
  type InputVideoTrack,
  type Source,
  type StreamTargetChunk,
  type VideoSample,
} from "mediabunny";

import { projectDurationUs } from "../timeline/timelineMath";
import {
  EXPORT_OUTPUT_DIRECTORY,
  type ExportSource,
  type ExportCodecQueueMetrics,
  type ExportQueueMetrics,
  type MediaExportProgress,
  type MediaExportResult,
  type WebCodecsEncoderQueueObservation,
} from "./export-types";

const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_ENCODER_CHUNK_FRAMES = 1024;
const CODEC_QUEUE_HIGH_WATERMARK = 8;
const VIDEO_CODEC = "avc1.640028";
const AUDIO_CODEC = "mp4a.40.2";

type ExportPipelineOptions = {
  logger?: StructuredLogger;
  onProgress?: (progress: MediaExportProgress) => void;
  project: ProjectDocument;
  requestId: string;
  signal: AbortSignal;
  sources: readonly ExportSource[];
};

type AssetRuntime = {
  audio: InputAudioTrack | null;
  input: Input;
  video: InputVideoTrack;
};

type OutputFile = {
  finalName: string;
  outputBytes: () => number;
  remove(): Promise<void>;
  target: StreamTarget;
  tempName: string;
  commit(): Promise<File>;
};

export type PlanarAudioMixInput = {
  channelData: readonly Float32Array[];
  numberOfFrames: number;
  sampleRate: number;
  timelineStartUs: number;
};

export type MixedAudioChunk = {
  data: Float32Array;
  frames: number;
  index: number;
  timestampUs: number;
};

function sourceAdapter(source: BrowserMediaSource): Source {
  return "blob" in source
    ? new BlobSource(source.blob, { maxCacheSize: 16 * 1024 * 1024 })
    : new UrlSource(source.url, {
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 2,
      });
}

async function createAssetRuntime(
  project: ProjectDocument,
  exportSource: ExportSource,
): Promise<AssetRuntime> {
  const asset = project.assets.find(
    (candidate) => candidate.id === exportSource.assetId,
  );
  if (!asset) {
    throw new Error(`导出源引用未知素材 "${exportSource.assetId}"`);
  }
  const input = new Input({
    formats: ALL_FORMATS,
    source: sourceAdapter(exportSource.source),
  });
  const videoTracks = await input.getVideoTracks();
  const video =
    videoTracks.find((track) => track.id === asset.media?.video.trackId) ??
    (await input.getPrimaryVideoTrack());
  if (!video) {
    input.dispose();
    throw new Error(`原素材 "${asset.name}" 不包含可解码视频轨`);
  }
  const audioTracks = await input.getAudioTracks();
  const audio =
    audioTracks.find((track) => track.id === asset.media?.audio?.trackId) ??
    (await video.getPrimaryPairableAudioTrack()) ??
    (await input.getPrimaryAudioTrack());
  return { audio, input, video };
}

function frameTimestampUs(frame: number, frameRate: number): number {
  return Math.round((frame * 1_000_000) / frameRate);
}

export function exportFrameCount(
  durationUs: number,
  frameRate: number,
): number {
  return Math.max(1, Math.ceil((durationUs * frameRate) / 1_000_000));
}

export function canvasFilter(effects: readonly NormalizedEffect[]): string {
  const filters: string[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "grayscale":
        filters.push(`grayscale(${effect.amount})`);
        break;
      case "vintage":
        filters.push(
          `sepia(${effect.amount}) saturate(${1 - effect.amount * 0.18}) contrast(${1 + effect.amount * 0.08})`,
        );
        break;
      case "adjustments":
        filters.push(
          `brightness(${1 + effect.brightness}) contrast(${0.5 + effect.contrast * 0.5})`,
        );
        break;
    }
  }
  return filters.join(" ") || "none";
}

export function normalizedAudioTimestampUs(
  timelineStartUs: number,
  sourceStartUs: number,
  decodedSourceTimeUs: number,
): number {
  return Math.max(0, timelineStartUs + decodedSourceTimeUs - sourceStartUs);
}

async function createOutputFile(requestId: string): Promise<OutputFile> {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(EXPORT_OUTPUT_DIRECTORY, {
    create: true,
  });
  const tempName = `.tmp-${requestId}.mp4`;
  const finalName = `export-${requestId}.mp4`;
  const tempHandle = await directory.getFileHandle(tempName, { create: true });
  const writable = await tempHandle.createWritable();
  let bytes = 0;
  const target = new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      abort: (reason) => writable.abort(reason),
      close: () => writable.close(),
      write: async (chunk) => {
        await writable.write({
          data: chunk.data,
          position: chunk.position,
          type: "write",
        });
        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
      },
    }),
    { chunked: true, chunkSize: 4 * 1024 * 1024 },
  );

  return {
    finalName,
    outputBytes: () => bytes,
    target,
    tempName,
    commit: async () => {
      const tempFile = await tempHandle.getFile();
      const finalHandle = await directory.getFileHandle(finalName, {
        create: true,
      });
      await tempFile.stream().pipeTo(await finalHandle.createWritable());
      await directory.removeEntry(tempName);
      return finalHandle.getFile();
    },
    remove: async () => {
      for (const path of [tempName, finalName]) {
        try {
          await directory.removeEntry(path);
        } catch (error) {
          if (!(
            error instanceof DOMException && error.name === "NotFoundError"
          )) {
            throw error;
          }
        }
      }
    },
  };
}

function drawVideo(
  context: OffscreenCanvasRenderingContext2D,
  canvas: OffscreenCanvas,
  sample: VideoSample,
  entity: RuntimeEntity,
): void {
  const sourceWidth = sample.displayWidth;
  const sourceHeight = sample.displayHeight;
  const fit = Math.min(
    entity.transform.width / sourceWidth,
    entity.transform.height / sourceHeight,
  );
  const width = sourceWidth * fit;
  const height = sourceHeight * fit;

  context.save();
  context.filter = canvasFilter(entity.effects.resolved);
  context.globalAlpha = entity.animation.opacity;
  context.translate(entity.transform.x, entity.transform.y);
  context.rotate(entity.transform.rotationRad);
  context.scale(entity.transform.scaleX, entity.transform.scaleY);
  sample.draw(context, -width / 2, -height / 2, width, height);
  context.restore();
  context.filter = "none";
  context.globalAlpha = 1;
  context.setTransform(1, 0, 0, 1, 0, 0);
  if (canvas.width === 0) {
    throw new Error("导出画布尺寸无效");
  }
}

function drawText(
  context: OffscreenCanvasRenderingContext2D,
  entity: RuntimeEntity,
): void {
  if (!entity.text) {
    return;
  }
  context.save();
  context.globalAlpha = entity.animation.opacity;
  context.fillStyle = entity.text.color;
  context.font = `700 ${entity.text.fontSize}px Inter, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.translate(entity.transform.x, entity.transform.y);
  context.rotate(entity.transform.rotationRad);
  context.scale(entity.transform.scaleX, entity.transform.scaleY);
  context.fillText(entity.text.value, 0, 0);
  context.restore();
}

export function composeFrame(
  canvas: OffscreenCanvas,
  context: OffscreenCanvasRenderingContext2D,
  backgroundColor: string,
  entities: readonly RuntimeEntity[],
  samplesByEntity: ReadonlyMap<string, VideoSample>,
): void {
  context.filter = "none";
  context.globalAlpha = 1;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (const entity of entities) {
    if (entity.video) {
      const sample = samplesByEntity.get(entity.id);
      if (sample) {
        drawVideo(context, canvas, sample, entity);
      }
    }
    if (entity.text) {
      drawText(context, entity);
    }
  }
}

function clipFrameTimestamps(
  project: ProjectDocument,
  clip: ProjectDocument["clips"][number],
  totalFrames: number,
): number[] {
  const timestamps: number[] = [];
  const frameRate = project.exportSettings.frameRate;
  const clipEndUs =
    clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs;
  for (let index = 0; index < totalFrames; index += 1) {
    const playheadUs = frameTimestampUs(index, frameRate);
    if (playheadUs >= clip.timelineStartUs && playheadUs < clipEndUs) {
      timestamps.push(
        (clip.sourceStartUs + playheadUs - clip.timelineStartUs) / 1_000_000,
      );
    }
  }
  return timestamps;
}

async function waitForQueue(
  encoder: VideoEncoder | AudioEncoder,
  signal: AbortSignal,
): Promise<void> {
  if (encoder.encodeQueueSize < CODEC_QUEUE_HIGH_WATERMARK) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      encoder.removeEventListener("dequeue", dequeued);
      reject(new DOMException(String(signal.reason ?? "已取消"), "AbortError"));
    };
    const dequeued = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    signal.addEventListener("abort", aborted, { once: true });
    encoder.addEventListener("dequeue", dequeued, { once: true });
  });
}

function encoderQueueObservation(
  codec: WebCodecsEncoderQueueObservation["codec"],
  encoder: AudioEncoder | VideoEncoder | undefined,
  peak: number,
  backpressureWaits: number,
): WebCodecsEncoderQueueObservation {
  return {
    applicationQueue: null,
    codec,
    implementation: "webcodecs",
    internalQueue: {
      available: Boolean(encoder),
      backpressureWaits,
      highWatermark: CODEC_QUEUE_HIGH_WATERMARK,
      peak,
      queueSize: encoder?.encodeQueueSize ?? null,
    },
  };
}

function aacAudioSpecificConfig(
  sampleRate: number,
  channels: number,
): Uint8Array {
  const rates = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000,
    12_000, 11_025, 8_000, 7_350,
  ];
  const rateIndex = rates.indexOf(sampleRate);
  if (rateIndex < 0 || channels < 1 || channels > 7) {
    throw new Error(
      `AAC 配置不支持 ${sampleRate}Hz/${channels}ch，请改用 48kHz 1-2ch`,
    );
  }
  const value = (2 << 11) | (rateIndex << 7) | (channels << 3);
  return new Uint8Array([value >> 8, value & 0xff]);
}

function outputAudioFrameCount(durationUs: number): number {
  return Math.max(1, Math.ceil((durationUs * AUDIO_SAMPLE_RATE) / 1_000_000));
}

function mixedAudioChunkTimestampUs(chunkIndex: number): number {
  return Math.round(
    (chunkIndex * AUDIO_ENCODER_CHUNK_FRAMES * 1_000_000) / AUDIO_SAMPLE_RATE,
  );
}

function createMixedAudioChunk(
  chunkIndex: number,
  totalFrames: number,
): MixedAudioChunk {
  const chunkStartFrame = chunkIndex * AUDIO_ENCODER_CHUNK_FRAMES;
  const frames = Math.max(
    0,
    Math.min(AUDIO_ENCODER_CHUNK_FRAMES, totalFrames - chunkStartFrame),
  );
  return {
    data: new Float32Array(frames * AUDIO_CHANNELS),
    frames,
    index: chunkIndex,
    timestampUs: mixedAudioChunkTimestampUs(chunkIndex),
  };
}

function ensureMixedAudioChunk(
  chunks: Map<number, MixedAudioChunk>,
  chunkIndex: number,
  totalFrames: number,
): MixedAudioChunk {
  const existing = chunks.get(chunkIndex);
  if (existing) {
    return existing;
  }
  const chunk = createMixedAudioChunk(chunkIndex, totalFrames);
  chunks.set(chunkIndex, chunk);
  return chunk;
}

export function mixPlanarAudioIntoChunks(
  chunks: Map<number, MixedAudioChunk>,
  input: PlanarAudioMixInput,
  durationUs: number,
): void {
  if (
    input.numberOfFrames <= 0 ||
    input.sampleRate <= 0 ||
    input.channelData.length === 0
  ) {
    return;
  }
  const totalFrames = outputAudioFrameCount(durationUs);
  const outputStartFrame = Math.max(
    0,
    Math.round((input.timelineStartUs * AUDIO_SAMPLE_RATE) / 1_000_000),
  );
  const resampledFrames = Math.max(
    1,
    Math.round((input.numberOfFrames * AUDIO_SAMPLE_RATE) / input.sampleRate),
  );

  for (let frame = 0; frame < resampledFrames; frame += 1) {
    const timelineFrame = outputStartFrame + frame;
    if (timelineFrame >= totalFrames) {
      break;
    }
    const chunkIndex = Math.floor(timelineFrame / AUDIO_ENCODER_CHUNK_FRAMES);
    const chunk = ensureMixedAudioChunk(chunks, chunkIndex, totalFrames);
    const localFrame = timelineFrame - chunkIndex * AUDIO_ENCODER_CHUNK_FRAMES;
    if (localFrame >= chunk.frames) {
      continue;
    }
    const sourcePosition =
      resampledFrames === 1
        ? 0
        : (frame * (input.numberOfFrames - 1)) / (resampledFrames - 1);
    const sourceLeft = Math.floor(sourcePosition);
    const sourceRight = Math.min(input.numberOfFrames - 1, sourceLeft + 1);
    const mix = sourcePosition - sourceLeft;

    for (let channel = 0; channel < AUDIO_CHANNELS; channel += 1) {
      const source =
        input.channelData[Math.min(channel, input.channelData.length - 1)];
      const value = source
        ? (source[sourceLeft] ?? 0) * (1 - mix) +
          (source[sourceRight] ?? 0) * mix
        : 0;
      const offset = channel * chunk.frames + localFrame;
      chunk.data[offset] = (chunk.data[offset] ?? 0) + value;
    }
  }
}

function audioDataFromMixedChunk(chunk: MixedAudioChunk): AudioData {
  const data = new Float32Array(chunk.data.length);
  for (let index = 0; index < chunk.data.length; index += 1) {
    data[index] = Math.max(-1, Math.min(1, chunk.data[index] ?? 0));
  }
  return new AudioData({
    data,
    format: "f32-planar",
    numberOfChannels: AUDIO_CHANNELS,
    numberOfFrames: chunk.frames,
    sampleRate: AUDIO_SAMPLE_RATE,
    timestamp: chunk.timestampUs,
  });
}

function planarAudioFromSample(sample: AudioSample): PlanarAudioMixInput {
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
    const plane = new Float32Array(sample.numberOfFrames);
    sample.copyTo(plane, { format: "f32-planar", planeIndex: channel });
    channelData.push(plane);
  }
  return {
    channelData,
    numberOfFrames: sample.numberOfFrames,
    sampleRate: sample.sampleRate,
    timelineStartUs: 0,
  };
}

async function resolveEncoderConfigs(
  project: ProjectDocument,
  hasAudio: boolean,
): Promise<{
  audio: AudioEncoderConfig | null;
  video: VideoEncoderConfig;
}> {
  if (typeof VideoEncoder === "undefined") {
    throw new Error(
      "H.264 导出不可用：当前平台缺少 VideoEncoder，请使用最新版 Chrome/Edge",
    );
  }
  const video: VideoEncoderConfig = {
    alpha: "discard",
    avc: { format: "avc" },
    bitrate: project.exportSettings.videoBitrate,
    codec: VIDEO_CODEC,
    framerate: project.exportSettings.frameRate,
    hardwareAcceleration: "no-preference",
    height: project.exportSettings.height,
    latencyMode: "quality",
    width: project.exportSettings.width,
  };
  const videoSupport = await VideoEncoder.isConfigSupported(video);
  if (!videoSupport.supported) {
    throw new Error(
      `H.264 编码配置不受支持：${VIDEO_CODEC} ${video.width}x${video.height}@${video.framerate}，请检查 Chrome 与系统硬件编解码支持`,
    );
  }
  if (!hasAudio) {
    return { audio: null, video: videoSupport.config ?? video };
  }
  if (typeof AudioEncoder === "undefined") {
    throw new Error(
      "AAC 导出不可用：当前平台缺少 AudioEncoder，请使用最新版 Chrome/Edge",
    );
  }
  const audio: AudioEncoderConfig = {
    aac: { format: "aac" },
    bitrate: project.exportSettings.audioBitrate,
    codec: AUDIO_CODEC,
    numberOfChannels: AUDIO_CHANNELS,
    sampleRate: AUDIO_SAMPLE_RATE,
  };
  const audioSupport = await AudioEncoder.isConfigSupported(audio);
  if (!audioSupport.supported) {
    throw new Error(
      `AAC 编码配置不受支持：${AUDIO_CODEC} ${AUDIO_SAMPLE_RATE}Hz/${AUDIO_CHANNELS}ch，请检查 Chrome 与系统 AAC 编码支持`,
    );
  }
  return {
    audio: audioSupport.config ?? audio,
    video: videoSupport.config ?? video,
  };
}

export function audibleAudioClips(
  project: ProjectDocument,
): ProjectDocument["clips"] {
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  return project.clips.filter((clip) => {
    const track = tracks.get(clip.trackId);
    if (track?.kind !== "audio" || track.muted) {
      return false;
    }
    const asset = assets.get(clip.assetId);
    return asset?.hasAudio === true && clip.sourceEndUs > clip.sourceStartUs;
  });
}

function shouldExportAudio(project: ProjectDocument): boolean {
  return audibleAudioClips(project).length > 0;
}

export async function exportProjectToMp4(
  options: ExportPipelineOptions,
): Promise<MediaExportResult> {
  const startedAt = performance.now();
  const { logger, project, requestId, signal } = options;
  const durationUs = projectDurationUs(project);
  const totalFrames = exportFrameCount(
    durationUs,
    project.exportSettings.frameRate,
  );
  const sourceMap = new Map(
    options.sources.map((source) => [source.assetId, source]),
  );
  const requiredAssetIds = new Set(project.clips.map((clip) => clip.assetId));
  for (const assetId of requiredAssetIds) {
    if (!sourceMap.has(assetId)) {
      throw new Error(
        `缺少素材 "${assetId}" 的原始 source；代理文件禁止用于导出`,
      );
    }
  }

  const runtimes = new Map<string, AssetRuntime>();
  let outputFile: OutputFile | undefined;
  let output: Output | undefined;
  let videoEncoder: VideoEncoder | undefined;
  let audioEncoder: AudioEncoder | undefined;
  let videoEncoderLease: ResourceLease | undefined;
  let audioEncoderLease: ResourceLease | undefined;
  let completed = false;
  let processedFrames = 0;
  let audioFrames = 0;
  let videoMux = Promise.resolve();
  let audioMux = Promise.resolve();
  let codecError: unknown;
  const lifecycle = new ResourceLifecycleTracker();
  const videoDecoderQueue = new MediabunnyDecoderQueueAdapter("VideoDecoder", {
    concurrency: 1,
    highWatermark: 1,
    logger,
  });
  const audioDecoderQueue = new MediabunnyDecoderQueueAdapter("AudioDecoder", {
    concurrency: 1,
    highWatermark: 1,
    logger,
  });
  const hasAudio = shouldExportAudio(project);
  const queue: ExportQueueMetrics = {
    audioBackpressureWaits: 0,
    audioPeak: 0,
    backpressureWaits: 0,
    highWatermark: CODEC_QUEUE_HIGH_WATERMARK,
    videoBackpressureWaits: 0,
    videoPeak: 0,
  };

  const report = (stage: MediaExportProgress["stage"]) => {
    const elapsedMs = performance.now() - startedAt;
    const frameRatio = totalFrames === 0 ? 0 : processedFrames / totalFrames;
    const etaMs =
      frameRatio > 0 && frameRatio < 1
        ? (elapsedMs / frameRatio) * (1 - frameRatio)
        : 0;
    const codecQueues: ExportCodecQueueMetrics = {
      audioDecoder: hasAudio ? audioDecoderQueue.stats() : null,
      audioEncoder: hasAudio
        ? encoderQueueObservation(
            "AudioEncoder",
            audioEncoder,
            queue.audioPeak,
            queue.audioBackpressureWaits,
          )
        : null,
      videoDecoder: videoDecoderQueue.stats(),
      videoEncoder: encoderQueueObservation(
        "VideoEncoder",
        videoEncoder,
        queue.videoPeak,
        queue.videoBackpressureWaits,
      ),
    };
    const progress: MediaExportProgress = {
      audioQueue: audioEncoder?.encodeQueueSize ?? 0,
      codecQueues,
      elapsedMs,
      etaMs,
      heap: sampleJsHeapMetrics(),
      outputBytes: outputFile?.outputBytes() ?? 0,
      processedFrames,
      queue: { ...queue },
      resources: lifecycle.snapshot(),
      stage,
      totalFrames,
      videoQueue: videoEncoder?.encodeQueueSize ?? 0,
    };
    options.onProgress?.(progress);
    logger?.log({
      event: "progress",
      input: { source: "original", stage },
      level: "debug",
      marker: "[EXPORT]",
      output: progress,
      projectRevision: project.revision,
      requestId,
    });
  };

  try {
    signal.throwIfAborted();
    const configs = await resolveEncoderConfigs(project, hasAudio);
    report("capability");
    logger?.log({
      event: "started",
      input: {
        assets: [...requiredAssetIds],
        frameRate: project.exportSettings.frameRate,
        height: project.exportSettings.height,
        source: "original",
        width: project.exportSettings.width,
      },
      level: "info",
      marker: "[EXPORT]",
      output: {
        audioConfig: configs.audio,
        mediaSource: "original",
        videoConfig: configs.video,
      },
      projectRevision: project.revision,
      requestId,
    });

    for (const assetId of requiredAssetIds) {
      signal.throwIfAborted();
      runtimes.set(
        assetId,
        await createAssetRuntime(project, sourceMap.get(assetId)!),
      );
    }

    outputFile = await createOutputFile(requestId);
    const videoSource = new EncodedVideoPacketSource("avc");
    const audioSource = configs.audio
      ? new EncodedAudioPacketSource("aac")
      : undefined;
    output = new Output({
      format: new Mp4OutputFormat({
        fastStart: "fragmented",
        minimumFragmentDuration: 1,
      }),
      target: outputFile.target,
    });
    output.addVideoTrack(videoSource, {
      frameRate: project.exportSettings.frameRate,
      rotation: 0,
    });
    if (audioSource) {
      output.addAudioTrack(audioSource);
    }
    await output.start();

    videoEncoder = new VideoEncoder({
      error: (error) => {
        codecError = error;
      },
      output: (chunk, metadata) => {
        const packet = EncodedPacket.fromEncodedChunk(chunk);
        videoMux = videoMux.then(() => videoSource.add(packet, metadata));
      },
    });
    videoEncoderLease = lifecycle.trackClosable("video-encoder", videoEncoder);
    videoEncoder.configure(configs.video);

    if (configs.audio && audioSource) {
      audioEncoder = new AudioEncoder({
        error: (error) => {
          codecError = error;
        },
        output: (chunk, metadata) => {
          const packet = EncodedPacket.fromEncodedChunk(chunk);
          const decoderConfig: AudioDecoderConfig = {
            codec: AUDIO_CODEC,
            description:
              metadata?.decoderConfig?.description ??
              aacAudioSpecificConfig(AUDIO_SAMPLE_RATE, AUDIO_CHANNELS),
            numberOfChannels: AUDIO_CHANNELS,
            sampleRate: AUDIO_SAMPLE_RATE,
          };
          audioMux = audioMux.then(() =>
            audioSource.add(packet, { decoderConfig }),
          );
        },
      });
      audioEncoderLease = lifecycle.trackClosable(
        "audio-encoder",
        audioEncoder,
      );
      audioEncoder.configure(configs.audio);
    }

    const canvas = new OffscreenCanvas(
      project.exportSettings.width,
      project.exportSettings.height,
    );
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("OffscreenCanvas 2D context 不可用，无法执行后台合成");
    }
    const adapter = new ProjectRuntimeAdapter({ quality: "export" });
    const clipSamples = new Map<
      string,
      AsyncIterator<VideoSample | null, void>
    >();
    for (const clip of project.clips) {
      const runtime = runtimes.get(clip.assetId);
      if (!runtime) {
        continue;
      }
      const timestamps = clipFrameTimestamps(project, clip, totalFrames);
      const samples = new VideoSampleSink(runtime.video).samplesAtTimestamps(
        timestamps,
      );
      clipSamples.set(clip.id, samples[Symbol.asyncIterator]());
    }

    const nominalFrameDurationUs = Math.round(
      1_000_000 / project.exportSettings.frameRate,
    );
    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
      signal.throwIfAborted();
      if (codecError) {
        throw codecError;
      }
      const timestampUs = frameTimestampUs(
        frameIndex,
        project.exportSettings.frameRate,
      );
      const duration = Math.max(
        1,
        Math.min(nominalFrameDurationUs, durationUs - timestampUs),
      );
      const evaluation = adapter.evaluate(project, timestampUs, requestId);
      const samplesByEntity = new Map<string, VideoSample>();
      try {
        for (const activeVideo of evaluation.activeVideos) {
          const clipId = activeVideo.entityId.replace(/^clip:/, "");
          const sampleIterator = clipSamples.get(clipId);
          if (!sampleIterator) {
            continue;
          }
          const nextSample = await videoDecoderQueue.schedule(
            `${requestId}.video.${frameIndex}.${activeVideo.entityId}`,
            async (queueSignal) => {
              queueSignal.throwIfAborted();
              const next = await sampleIterator.next();
              queueSignal.throwIfAborted();
              return next;
            },
            signal,
          ).result;
          const sample = nextSample.value ?? null;
          if (sample) {
            samplesByEntity.set(activeVideo.entityId, sample);
          }
        }
        composeFrame(
          canvas,
          context,
          project.canvas.backgroundColor,
          evaluation.activeEntities,
          samplesByEntity,
        );
      } finally {
        for (const sample of samplesByEntity.values()) {
          sample.close();
        }
      }
      const frame = new VideoFrame(canvas, {
        duration,
        timestamp: timestampUs,
      });
      const frameLease = lifecycle.trackClosable("video-frame", frame);
      try {
        if (videoEncoder.encodeQueueSize >= CODEC_QUEUE_HIGH_WATERMARK) {
          queue.backpressureWaits += 1;
          queue.videoBackpressureWaits += 1;
        }
        await waitForQueue(videoEncoder, signal);
        if (videoEncoder.encodeQueueSize >= CODEC_QUEUE_HIGH_WATERMARK - 1) {
          logger?.log({
            event: "backpressure",
            input: { source: "original" },
            level: "debug",
            marker: "[EXPORT]",
            output: { videoQueue: videoEncoder.encodeQueueSize },
            projectRevision: project.revision,
            requestId,
          });
        }
        videoEncoder.encode(frame, {
          keyFrame:
            frameIndex %
              Math.max(1, Math.round(project.exportSettings.frameRate * 2)) ===
            0,
        });
        queue.videoPeak = Math.max(
          queue.videoPeak,
          videoEncoder.encodeQueueSize,
        );
      } finally {
        frameLease.release();
      }
      processedFrames += 1;
      if (processedFrames % 5 === 0 || processedFrames === totalFrames) {
        report("video");
      }
    }
    await videoEncoder.flush();
    await videoMux;
    videoSource.close();
    videoEncoderLease.release();
    videoEncoderLease = undefined;
    adapter.dispose();

    if (audioEncoder && audioSource) {
      const mixedChunks = new Map<number, MixedAudioChunk>();
      const totalAudioFrames = outputAudioFrameCount(durationUs);
      const totalAudioChunks = Math.ceil(
        totalAudioFrames / AUDIO_ENCODER_CHUNK_FRAMES,
      );
      for (const clip of [...audibleAudioClips(project)].sort(
        (left, right) => left.timelineStartUs - right.timelineStartUs,
      )) {
        signal.throwIfAborted();
        if (codecError) {
          throw codecError;
        }
        const runtime = runtimes.get(clip.assetId);
        if (!runtime?.audio) {
          continue;
        }
        const sink = new AudioSampleSink(runtime.audio);
        const sourceStartSec = clip.sourceStartUs / 1_000_000;
        const sourceEndSec = clip.sourceEndUs / 1_000_000;
        const sampleStream = sink.samples(sourceStartSec, sourceEndSec);
        const samples = sampleStream[Symbol.asyncIterator]();
        let decodedIndex = 0;
        while (true) {
          const next = await audioDecoderQueue.schedule(
            `${requestId}.audio.${clip.id}.${decodedIndex}`,
            async (queueSignal) => {
              queueSignal.throwIfAborted();
              const value = await samples.next();
              queueSignal.throwIfAborted();
              return value;
            },
            signal,
          ).result;
          if (next.done) {
            break;
          }
          const decoded = next.value;
          decodedIndex += 1;
          signal.throwIfAborted();
          const overlapStart = Math.max(decoded.timestamp, sourceStartSec);
          const overlapEnd = Math.min(
            decoded.timestamp + decoded.duration,
            sourceEndSec,
          );
          const startFrame = Math.max(
            0,
            Math.ceil(
              (overlapStart - decoded.timestamp) * decoded.sampleRate - 1e-6,
            ),
          );
          const endFrame = Math.min(
            decoded.numberOfFrames,
            Math.ceil(
              (overlapEnd - decoded.timestamp) * decoded.sampleRate - 1e-6,
            ),
          );
          if (endFrame <= startFrame) {
            decoded.close();
            continue;
          }
          const sample =
            startFrame === 0 && endFrame === decoded.numberOfFrames
              ? decoded
              : decoded.trim(startFrame, endFrame);
          if (sample !== decoded) {
            decoded.close();
          }
          try {
            const timestampUs = normalizedAudioTimestampUs(
              clip.timelineStartUs,
              clip.sourceStartUs,
              Math.round(sample.timestamp * 1_000_000),
            );
            const mixInput = planarAudioFromSample(sample);
            mixPlanarAudioIntoChunks(
              mixedChunks,
              {
                ...mixInput,
                timelineStartUs: timestampUs,
              },
              durationUs,
            );
          } finally {
            sample.close();
          }
        }
        report("audio");
      }
      for (let chunkIndex = 0; chunkIndex < totalAudioChunks; chunkIndex += 1) {
        signal.throwIfAborted();
        if (codecError) {
          throw codecError;
        }
        const mixedChunk =
          mixedChunks.get(chunkIndex) ??
          createMixedAudioChunk(chunkIndex, totalAudioFrames);
        if (mixedChunk.frames <= 0) {
          continue;
        }
        const audioData = audioDataFromMixedChunk(mixedChunk);
        const audioDataLease = lifecycle.trackClosable("audio-data", audioData);
        try {
          if (audioEncoder.encodeQueueSize >= CODEC_QUEUE_HIGH_WATERMARK) {
            queue.backpressureWaits += 1;
            queue.audioBackpressureWaits += 1;
          }
          await waitForQueue(audioEncoder, signal);
          if (audioEncoder.encodeQueueSize >= CODEC_QUEUE_HIGH_WATERMARK - 1) {
            logger?.log({
              event: "backpressure",
              input: { source: "original" },
              level: "debug",
              marker: "[EXPORT]",
              output: { audioQueue: audioEncoder.encodeQueueSize },
              projectRevision: project.revision,
              requestId,
            });
          }
          audioEncoder.encode(audioData);
          audioFrames += audioData.numberOfFrames;
          queue.audioPeak = Math.max(
            queue.audioPeak,
            audioEncoder.encodeQueueSize,
          );
        } finally {
          audioDataLease.release();
        }
        if (chunkIndex % 16 === 0 || chunkIndex === totalAudioChunks - 1) {
          report("audio");
        }
      }
      await audioEncoder.flush();
      await audioMux;
      audioSource.close();
      audioEncoderLease?.release();
      audioEncoderLease = undefined;
    }

    signal.throwIfAborted();
    if (codecError) {
      throw codecError;
    }
    report("mux");
    await output.finalize();
    const file = await outputFile.commit();
    completed = true;
    const result: MediaExportResult = {
      audioCodec: configs.audio ? AUDIO_CODEC : null,
      audioFrames,
      bytes: file.size,
      codecQueues: {
        audioDecoder: configs.audio ? audioDecoderQueue.stats() : null,
        audioEncoder: configs.audio
          ? encoderQueueObservation(
              "AudioEncoder",
              audioEncoder,
              queue.audioPeak,
              queue.audioBackpressureWaits,
            )
          : null,
        videoDecoder: videoDecoderQueue.stats(),
        videoEncoder: encoderQueueObservation(
          "VideoEncoder",
          videoEncoder,
          queue.videoPeak,
          queue.videoBackpressureWaits,
        ),
      },
      durationUs,
      elapsedMs: performance.now() - startedAt,
      fileName: outputFile.finalName,
      frames: totalFrames,
      height: project.exportSettings.height,
      heap: sampleJsHeapMetrics(),
      mimeType: "video/mp4",
      opfsPath: outputFile.finalName,
      queue: { ...queue },
      resources: lifecycle.snapshot(),
      source: "original",
      videoCodec: VIDEO_CODEC,
      width: project.exportSettings.width,
    };
    report("completed");
    logger?.log({
      durationMs: result.elapsedMs,
      event: "completed",
      input: {
        source: "original",
        sourceAssets: [...requiredAssetIds],
      },
      level: "info",
      marker: "[EXPORT]",
      output: result,
      projectRevision: project.revision,
      requestId,
    });
    return result;
  } catch (error) {
    const cancelled =
      signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    logger?.log({
      durationMs: performance.now() - startedAt,
      error,
      event: cancelled ? "cancelled" : "failed",
      input: {
        source: "original",
        sourceAssets: [...requiredAssetIds],
      },
      level: cancelled ? "warn" : "error",
      marker: "[EXPORT]",
      output: {
        processedFrames,
        temporaryCleaned: true,
      },
      projectRevision: project.revision,
      requestId,
    });
    throw error;
  } finally {
    if (!completed && output && output.state !== "canceled") {
      await output.cancel().catch(() => undefined);
    }
    videoEncoderLease?.release();
    audioEncoderLease?.release();
    videoDecoderQueue.dispose();
    audioDecoderQueue.dispose();
    for (const runtime of runtimes.values()) {
      if (!runtime.input.disposed) {
        runtime.input.dispose();
      }
    }
    if (!completed) {
      await outputFile?.remove().catch(() => undefined);
    }
  }
}
