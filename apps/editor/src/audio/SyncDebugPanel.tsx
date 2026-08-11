import type { ProjectDocument } from "@web-video-editor/domain";
import {
  MEDIA_PROXY_RESULT_VERSION,
  MediabunnyAudioPlayback,
  calculateProxyDimensions,
  createAudioRingBuffer,
  mediaProbeToProjectAsset,
  probeBrowserMedia,
  type AudioPlaybackStats,
  type AudioRingBuffer,
  type ProxyManifest,
} from "@web-video-editor/media-runtime";
import {
  ConsoleLogSink,
  LogHub,
  StructuredLogger,
} from "@web-video-editor/observability";
import {
  PixiPreviewRenderer,
  PreviewDecoderClient,
  PreviewRuntime,
  resolveQualityProfile,
  type PreviewRuntimeSnapshot,
  type PreviewSource,
} from "@web-video-editor/preview-runtime";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ActionAvailability } from "../capabilities";
import "./SyncDebugPanel.css";

const TEST_ASSETS = [
  { name: "test_1.mp4", url: "/test_assets/test_1.mp4" },
  { name: "test_2.mp4", url: "/test_assets/test_2.mp4" },
  { name: "test_3.mp4", url: "/test_assets/test_3.mp4" },
] as const;

type TestAssetName = (typeof TEST_ASSETS)[number]["name"];

type SyncDiagnostics = {
  getAudioStats(): AudioPlaybackStats | undefined;
  getRingStats(): {
    availableRead: number;
    fallbackMessages: number;
    mode: AudioRingBuffer["mode"];
  };
  getSnapshot(): PreviewRuntimeSnapshot | undefined;
  pause(): void;
  play(): void;
  seek(timeUs: number): void;
  select(name: TestAssetName): void;
};

declare global {
  interface Window {
    __TASK_9_SYNC__?: SyncDiagnostics;
  }
}

function manifestFor(
  cacheKey: string,
  durationSec: number,
  width: number,
  height: number,
): ProxyManifest {
  const proxy = calculateProxyDimensions(width, height, {
    maxHeight: 540,
    maxWidth: 960,
  });
  return {
    cacheKey,
    cover: {
      byteLength: 0,
      height: 0,
      mimeType: "image/webp",
      path: "unused",
      timestampSec: 0,
      width: 0,
    },
    createdAt: new Date().toISOString(),
    fingerprint: cacheKey,
    keyframes: [],
    parameters: {
      frameRate: 30,
      keyFrameIntervalSec: 2,
      maxHeight: 540,
      maxThumbnailCount: 120,
      maxWidth: 960,
      thumbnailIntervalSec: 5,
      thumbnailWidth: 160,
      waveformBuckets: 512,
    },
    proxy: {
      byteLength: 0,
      durationSec,
      frameRate: 30,
      height: proxy.height,
      mimeType: "video/mp4",
      path: "unused",
      width: proxy.width,
    },
    source: { durationSec, height, width },
    thumbnails: [],
    version: MEDIA_PROXY_RESULT_VERSION,
    waveform: {
      bucketCount: 0,
      byteLength: 0,
      maxValue: 0,
      mimeType: "application/x-float32",
      minValue: 0,
      path: "unused",
      rmsMax: 0,
      sampleCount: 0,
    },
  };
}

function projectFor(
  name: TestAssetName,
  url: string,
  probe: Awaited<ReturnType<typeof probeBrowserMedia>>,
): { project: ProjectDocument; source: PreviewSource } {
  const asset = mediaProbeToProjectAsset(probe);
  const durationUs = asset.durationUs;
  const now = new Date().toISOString();
  const project: ProjectDocument = {
    assets: [asset],
    canvas: {
      backgroundColor: "#090b10",
      height: asset.height,
      width: asset.width,
    },
    clips: [
      {
        assetId: asset.id,
        effects: [],
        id: `clip-${name}`,
        sourceEndUs: durationUs,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "video-track",
      },
    ],
    createdAt: now,
    exportSettings: {
      audioBitrate: 192_000,
      audioCodec: "aac",
      frameRate: asset.frameRate,
      height: asset.height,
      videoBitrate: 8_000_000,
      videoCodec: "h264",
      width: asset.width,
    },
    id: `task-9-${name}`,
    name: `Task 9 ${name} A/V sync`,
    revision: TEST_ASSETS.findIndex((candidate) => candidate.name === name) + 1,
    schemaVersion: 1,
    texts: [],
    tracks: [
      {
        id: "video-track",
        kind: "video",
        locked: false,
        muted: false,
        name: "视频",
        order: 0,
      },
      {
        id: "audio-track",
        kind: "audio",
        locked: false,
        muted: false,
        name: "音频",
        order: 1,
      },
    ],
    updatedAt: now,
  };
  return {
    project,
    source: {
      assetId: asset.id,
      cacheStatus: "miss",
      keyframes: [],
      manifest: manifestFor(
        probe.fingerprint,
        probe.durationSec,
        asset.width,
        asset.height,
      ),
      mediaUrl: url,
    },
  };
}

function formatTime(timeUs: number): string {
  return `${(timeUs / 1_000_000).toFixed(3)}s`;
}

export function SyncDebugPanel({
  actionAvailability,
  embedded = false,
}: {
  actionAvailability?: ActionAvailability;
  embedded?: boolean;
}) {
  const [selected, setSelected] = useState<TestAssetName>("test_1.mp4");
  const [loadedAsset, setLoadedAsset] = useState<TestAssetName>();
  const [snapshot, setSnapshot] = useState<PreviewRuntimeSnapshot>();
  const [audioStats, setAudioStats] = useState<AudioPlaybackStats>();
  const [fallbackMessageCount, setFallbackMessageCount] = useState(0);
  const [error, setError] = useState<string>();
  const [, setRingVersion] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<PreviewRuntime | undefined>(undefined);
  const audioRef = useRef<MediabunnyAudioPlayback | undefined>(undefined);
  const forceMessage = new URLSearchParams(location.search).has("forceMessage");
  const sharedMemoryEnabled = actionAvailability?.enabled === true;
  const ring = useMemo(
    () =>
      createAudioRingBuffer(48_000 * 2, 2, {
        crossOriginIsolated: forceMessage ? false : undefined,
        publishFallback: () => {
          setFallbackMessageCount((value) => value + 1);
        },
      }),
    [forceMessage],
  );

  useEffect(() => {
    window.__TASK_9_SYNC__ = {
      getAudioStats: () => audioRef.current?.stats(),
      getRingStats: () => ({
        availableRead: ring.availableRead,
        fallbackMessages: fallbackMessageCount,
        mode: ring.mode,
      }),
      getSnapshot: () => runtimeRef.current?.getSnapshot(),
      pause: () => runtimeRef.current?.pause(),
      play: () => runtimeRef.current?.play(),
      seek: (timeUs) => runtimeRef.current?.seek(timeUs),
      select: setSelected,
    };
    return () => {
      delete window.__TASK_9_SYNC__;
    };
  }, [fallbackMessageCount, ring]);

  useEffect(() => {
    if (!sharedMemoryEnabled) {
      return;
    }
    const host = hostRef.current;
    const descriptor = TEST_ASSETS.find((asset) => asset.name === selected);
    if (!host || !descriptor) {
      return;
    }
    let disposed = false;
    let runtime: PreviewRuntime | undefined;
    let decoder: PreviewDecoderClient | undefined;
    let renderer: PixiPreviewRenderer | undefined;
    let audio: MediabunnyAudioPlayback | undefined;
    let unsubscribe: () => void = () => undefined;
    setSnapshot(undefined);
    setAudioStats(undefined);
    setFallbackMessageCount(0);
    setLoadedAsset(undefined);
    setError(undefined);
    ring.clear();
    const logHub = new LogHub([new ConsoleLogSink()]);
    const logger = new StructuredLogger(logHub, "sync-debug");

    void probeBrowserMedia(
      {
        kind: "test-asset",
        name: descriptor.name,
        url: descriptor.url,
      },
      { logger, requestId: `sync-probe-${descriptor.name}` },
    )
      .then(async (probe) => {
        if (disposed) {
          return;
        }
        const demo = projectFor(descriptor.name, descriptor.url, probe);
        renderer = new PixiPreviewRenderer({
          backgroundColor: demo.project.canvas.backgroundColor,
          logger,
          profile: resolveQualityProfile(demo.project, "preview"),
        });
        await renderer.init(host);
        if (disposed) {
          renderer.destroy();
          return;
        }
        decoder = new PreviewDecoderClient(
          () =>
            new Worker(new URL("./sync-video.worker.ts", import.meta.url), {
              name: "sync-video-worker",
              type: "module",
            }),
          logger,
          undefined,
          logHub,
        );
        audio = new MediabunnyAudioPlayback({
          logger,
          onDecodedBuffer: (buffer) => {
            const channels = Math.min(2, buffer.numberOfChannels);
            const frames = Math.min(
              buffer.length,
              Math.floor(ring.availableWrite / 2),
            );
            const interleaved = new Float32Array(frames * 2);
            for (let frame = 0; frame < frames; frame += 1) {
              interleaved[frame * 2] = buffer.getChannelData(0)[frame] ?? 0;
              interleaved[frame * 2 + 1] =
                buffer.getChannelData(channels - 1)[frame] ?? 0;
            }
            ring.write(interleaved);
            setRingVersion((value) => value + 1);
          },
          sources: new Map([
            [
              demo.source.assetId,
              { kind: "url", url: descriptor.url } as const,
            ],
          ]),
        });
        audioRef.current = audio;
        runtime = new PreviewRuntime({
          audio,
          decoder,
          logger,
          project: demo.project,
          renderer,
          sources: [demo.source],
        });
        runtimeRef.current = runtime;
        const update = () => {
          if (runtime) {
            setSnapshot(runtime.getSnapshot());
            setAudioStats(audio?.stats());
          }
        };
        unsubscribe = runtime.subscribe(update);
        update();
        setLoadedAsset(descriptor.name);
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });

    return () => {
      disposed = true;
      unsubscribe();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = undefined;
      }
      if (audioRef.current === audio) {
        audioRef.current = undefined;
      }
      if (runtime) {
        runtime.dispose();
      } else {
        decoder?.dispose();
        renderer?.destroy();
      }
    };
  }, [ring, selected, sharedMemoryEnabled]);

  const metrics = snapshot?.metrics;

  const content = (
    <>
      <header className="sync-debug__header">
        <div>
          <p className="eyebrow">A/V SYNC · TASK 09</p>
          <h1>单调工程时钟与真实音频调度</h1>
          <p>
            AudioContext 主时钟 → timestamp 视频选择；Seek/revision 通过
            generation 停止并淘汰旧缓冲。
          </p>
        </div>
        <span data-testid="ring-mode">RING: {ring.mode.toUpperCase()}</span>
      </header>

      <nav className="sync-debug__assets" aria-label="同步测试素材">
        {TEST_ASSETS.map((asset) => (
          <button
            aria-pressed={selected === asset.name}
            disabled={!sharedMemoryEnabled}
            key={asset.name}
            onClick={() => setSelected(asset.name)}
            type="button"
          >
            {asset.name}
          </button>
        ))}
      </nav>

      {!actionAvailability ? (
        <p className="sync-debug__diagnosis">正在检测共享内存能力…</p>
      ) : !actionAvailability.enabled ? (
        <p className="sync-debug__diagnosis" role="alert">
          共享内存实验已禁用：{actionAvailability.reason}
        </p>
      ) : null}

      <section
        className="sync-debug__stage"
        data-loaded-asset={loadedAsset}
        data-ready={String(snapshot?.ready ?? false)}
        data-testid="sync-panel"
      >
        <div ref={hostRef} />
        {!snapshot && !error ? <p>正在探测 Range 素材…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </section>

      <div className="sync-debug__controls">
        <button
          disabled={!sharedMemoryEnabled || !snapshot?.ready}
          onClick={() =>
            snapshot?.playing
              ? runtimeRef.current?.pause()
              : runtimeRef.current?.play()
          }
          type="button"
        >
          {snapshot?.playing ? "暂停" : "播放"}
        </button>
        <span>{formatTime(metrics?.playheadUs ?? 0)}</span>
        <input
          aria-label="同步播放头"
          disabled={!sharedMemoryEnabled || !snapshot?.ready}
          max={snapshot?.durationUs ?? 0}
          min={0}
          onChange={(event) =>
            runtimeRef.current?.seek(Number(event.currentTarget.value))
          }
          step={1}
          type="range"
          value={metrics?.playheadUs ?? 0}
        />
        <span>{formatTime(snapshot?.durationUs ?? 0)}</span>
      </div>

      <dl className="sync-debug__metrics">
        <div>
          <dt>主时钟</dt>
          <dd data-testid="clock-source">
            {metrics?.clockSource ?? "performance"} /{" "}
            {metrics?.clockTransportMode ?? ring.mode}
          </dd>
        </div>
        <div>
          <dt>A/V drift</dt>
          <dd data-testid="av-drift-us">{metrics?.avDriftUs ?? 0} us</dd>
        </div>
        <div>
          <dt>Timestamp error</dt>
          <dd>{metrics?.frameTimestampErrorUs ?? 0} us</dd>
        </div>
        <div>
          <dt>Drop / Resync</dt>
          <dd>
            {metrics?.timestampDrops ?? 0} / {metrics?.resyncs ?? 0}
          </dd>
        </div>
        <div>
          <dt>Audio generation</dt>
          <dd data-testid="audio-generation">
            {audioStats?.generation ?? metrics?.audioGeneration ?? 0}
          </dd>
        </div>
        <div>
          <dt>活跃旧/新音频节点</dt>
          <dd data-testid="active-audio">
            {audioStats?.activeSources ?? 0} /{" "}
            {audioStats?.activeGenerations.join(",") || "none"}
          </dd>
        </div>
        <div>
          <dt>SAB ring samples</dt>
          <dd data-testid="ring-samples">
            {ring.availableRead} / fallback {fallbackMessageCount}
          </dd>
        </div>
      </dl>
    </>
  );
  return embedded ? (
    <section className="sync-debug sync-debug--embedded">{content}</section>
  ) : (
    <main className="sync-debug">{content}</main>
  );
}
