// @vitest-environment jsdom

import {
  createProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionAvailability } from "../capabilities";
import { PreviewPanel } from "./PreviewPanel";

const runtimeMocks = vi.hoisted(() => {
  type HeapSample = {
    available: boolean;
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
    usedJSHeapSize?: number;
  };
  type StorageSample = {
    available: boolean;
    quotaBytes?: number;
    usageBytes?: number;
  };
  type QueueStats = {
    active: number;
    activePeak: number;
    backpressureCount: number;
    concurrency: number;
    highWatermark: number;
    queued: number;
    queuedPeak: number;
  };
  const defaultQueueStats = (): QueueStats => ({
    active: 0,
    activePeak: 0,
    backpressureCount: 0,
    concurrency: 1,
    highWatermark: 1,
    queued: 0,
    queuedPeak: 0,
  });
  const mock = {
    activeAudioSources: 0,
    activeResources: 0,
    activeVideoLayers: 0,
    activeVideoFrames: 0,
    audioQueueStats: undefined as QueueStats | undefined,
    heapSample: { available: false } as HeapSample,
    instances: [] as Array<{
      getSnapshot: ReturnType<typeof vi.fn>;
      pause: ReturnType<typeof vi.fn>;
      play: ReturnType<typeof vi.fn>;
      seek: ReturnType<typeof vi.fn>;
      step: ReturnType<typeof vi.fn>;
    }>,
    storageSample: { available: false } as StorageSample,
    videoQueueStats: defaultQueueStats(),
  };
  const queue = (codec: "AudioDecoder" | "VideoDecoder" = "VideoDecoder") => ({
    applicationQueue: {
      ...(codec === "AudioDecoder" && mock.audioQueueStats
        ? mock.audioQueueStats
        : mock.videoQueueStats),
    },
    codec,
    implementation: "mediabunny",
    internalQueue: {
      available: false,
      highWatermark: null,
      peak: null,
      queueSize: null,
      reason: "mock",
    },
  });
  return Object.assign(mock, {
    queue,
    reset() {
      mock.activeAudioSources = 0;
      mock.activeResources = 0;
      mock.activeVideoLayers = 0;
      mock.activeVideoFrames = 0;
      mock.audioQueueStats = undefined;
      mock.heapSample = { available: false };
      mock.instances.length = 0;
      mock.storageSample = { available: false };
      mock.videoQueueStats = defaultQueueStats();
    },
  });
});

vi.mock("@web-video-editor/media-runtime", () => ({
  MediabunnyAudioPlayback: class {
    dispose = vi.fn();
    setSources = vi.fn();
  },
  createMediabunnyDecoderQueueObservation: runtimeMocks.queue,
  sampleJsHeapMetrics: () => runtimeMocks.heapSample,
  sampleStorageEstimate: () => Promise.resolve(runtimeMocks.storageSample),
}));

vi.mock("@web-video-editor/preview-runtime", () => {
  const profile = {
    frameRate: 30,
    height: 360,
    kind: "preview",
    mediaSource: "proxy",
    width: 640,
  };
  return {
    PixiPreviewRenderer: class {
      destroy = vi.fn();
      init = vi.fn(() => Promise.resolve());
    },
    PreviewDecoderClient: class {
      activeResources = () => 0;
      dispose = vi.fn();
      resourceSnapshot = () => ({
        byType: { "video-frame": { active: 0 } },
      });
      stats = () => ({ decoderQueue: runtimeMocks.queue() });
      subscribeStats = () => () => undefined;
    },
    PreviewRuntime: class {
      private listeners = new Set<() => void>();
      private snapshot;

      constructor(options: { project: ProjectDocument }) {
        this.snapshot = {
          buffering: false,
          durationUs: Math.max(
            0,
            ...options.project.clips.map(
              (clip) =>
                clip.timelineStartUs + clip.sourceEndUs - clip.sourceStartUs,
            ),
          ),
          metrics: {
            activeResources: runtimeMocks.activeResources,
            activeVideoLayers: runtimeMocks.activeVideoLayers,
            audioActiveSources: runtimeMocks.activeAudioSources,
            audioGeneration: 0,
            avDriftUs: 0,
            cacheHitRate: 1,
            clockSource: "performance",
            clockTransportMode: "message",
            codecQueues: {
              audioDecoder: runtimeMocks.audioQueueStats
                ? runtimeMocks.queue("AudioDecoder")
                : null,
              videoDecoder: runtimeMocks.queue(),
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
        runtimeMocks.instances.push(this);
      }

      dispose = vi.fn();
      getSnapshot = vi.fn(() => this.snapshot);
      pause = vi.fn(() => {
        if (!this.snapshot.playing && !this.snapshot.buffering) {
          return;
        }
        this.snapshot = {
          ...this.snapshot,
          buffering: false,
          playing: false,
        };
        this.notify();
      });
      play = vi.fn(() => {
        if (this.snapshot.playing || this.snapshot.buffering) {
          return;
        }
        this.snapshot = {
          ...this.snapshot,
          playing: true,
        };
        this.notify();
      });
      resourceSnapshot = () => ({
        byType: { "video-frame": { active: runtimeMocks.activeVideoFrames } },
      });
      seek = vi.fn((playheadUs: number) => {
        this.snapshot = {
          ...this.snapshot,
          metrics: {
            ...this.snapshot.metrics,
            playheadUs: Math.max(
              0,
              Math.min(Math.round(playheadUs), this.snapshot.durationUs),
            ),
          },
          playing: false,
        };
        this.notify();
      });
      setAudioSources = vi.fn();
      setProject = vi.fn();
      setSources = vi.fn();
      step = vi.fn((direction: -1 | 1) => {
        this.pause();
        this.seek(
          this.snapshot.metrics.playheadUs +
            Math.round(1_000_000 / profile.frameRate) * direction,
        );
      });
      subscribe = vi.fn((listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      });

      private notify() {
        for (const listener of this.listeners) {
          listener();
        }
      }
    },
    previewSourceMetadata: (source: {
      cacheKey?: string;
      frameRate?: number;
      height?: number;
      manifest?: { cacheKey: string };
      width?: number;
    }) => ({
      cacheKey: source.cacheKey ?? source.manifest?.cacheKey ?? "cache",
      frameRate: source.frameRate ?? profile.frameRate,
      height: source.height ?? profile.height,
      width: source.width ?? profile.width,
    }),
    resolveQualityProfile: () => profile,
  };
});

function projectFixture(): ProjectDocument {
  const project = createProjectDocument({
    id: "preview-keyboard-test",
    name: "Preview keyboard test",
    now: "2026-08-18T00:00:00.000Z",
  });
  project.assets.push({
    durationUs: 5_000_000,
    fingerprint: "asset",
    frameRate: 30,
    hasAudio: false,
    height: 720,
    id: "asset",
    name: "test.mp4",
    source: { kind: "test-asset", name: "test.mp4", size: 100 },
    width: 1280,
  });
  project.clips.push({
    assetId: "asset",
    effects: [],
    id: "clip",
    sourceEndUs: 5_000_000,
    sourceStartUs: 0,
    timelineStartUs: 0,
    trackId: "video-track",
  });
  return project;
}

const previewAvailable: ActionAvailability = {
  enabled: true,
  id: "preview",
  label: "启动预览",
  missing: [],
  reason: "ok",
};

const previewDisabled: ActionAvailability = {
  enabled: false,
  id: "preview",
  label: "启动预览",
  missing: ["worker"],
  reason: "disabled",
};

const sourceFixture = {
  assetId: "asset",
  cacheKey: "source-cache",
  cacheStatus: "hit" as const,
  frameRate: 30,
  height: 360,
  keyframes: [],
  mediaUrl: "blob:preview",
  width: 640,
};

async function renderReadyPreview(onPlayheadChange = vi.fn()) {
  render(
    <PreviewPanel
      actionAvailability={previewAvailable}
      onPlayheadChange={onPlayheadChange}
      project={projectFixture()}
      sources={[sourceFixture]}
    />,
  );
  await waitFor(() => expect(runtimeMocks.instances.length).toBe(1));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "播放" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  return {
    onPlayheadChange,
    runtime: runtimeMocks.instances[0]!,
  };
}

function dispatchWindowKey(key: string, code = key) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    code,
    key,
  });
  window.dispatchEvent(event);
  return event;
}

describe("PreviewPanel keyboard shortcuts", () => {
  beforeEach(() => {
    runtimeMocks.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it("toggles playback with Space and only prevents the handled Space default", async () => {
    const { runtime } = await renderReadyPreview();

    const playEvent = dispatchWindowKey(" ", "Space");
    expect(playEvent.defaultPrevented).toBe(true);
    expect(runtime.play).toHaveBeenCalledTimes(1);

    const pauseEvent = dispatchWindowKey(" ", "Space");
    expect(pauseEvent.defaultPrevented).toBe(true);
    expect(runtime.pause).toHaveBeenCalledTimes(1);
  });

  it("steps frames with ArrowLeft and ArrowRight while syncing the playhead", async () => {
    const onPlayheadChange = vi.fn();
    const { runtime } = await renderReadyPreview(onPlayheadChange);
    onPlayheadChange.mockClear();

    const rightEvent = dispatchWindowKey("ArrowRight");
    expect(rightEvent.defaultPrevented).toBe(false);
    expect(runtime.step).toHaveBeenCalledWith(1);
    await waitFor(() =>
      expect(onPlayheadChange).toHaveBeenLastCalledWith(33_333),
    );

    const leftEvent = dispatchWindowKey("ArrowLeft");
    expect(leftEvent.defaultPrevented).toBe(false);
    expect(runtime.step).toHaveBeenCalledWith(-1);
    await waitFor(() => expect(onPlayheadChange).toHaveBeenLastCalledWith(0));
  });

  it("does not handle shortcuts before preview is ready or when preview is unavailable", () => {
    render(
      <PreviewPanel
        actionAvailability={previewAvailable}
        project={projectFixture()}
        sources={[sourceFixture]}
      />,
    );
    const notReadyEvent = dispatchWindowKey(" ", "Space");
    expect(notReadyEvent.defaultPrevented).toBe(false);
    expect(runtimeMocks.instances.length).toBe(0);

    cleanup();
    runtimeMocks.instances.length = 0;
    render(
      <PreviewPanel
        actionAvailability={previewDisabled}
        project={projectFixture()}
        sources={[sourceFixture]}
      />,
    );
    const disabledEvent = dispatchWindowKey(" ", "Space");
    expect(disabledEvent.defaultPrevented).toBe(false);
    expect(runtimeMocks.instances.length).toBe(0);
  });

  it("does not handle shortcuts from form controls or contenteditable targets", async () => {
    const { runtime } = await renderReadyPreview();
    runtime.play.mockClear();
    runtime.step.mockClear();

    const slider = screen.getByRole("slider", { name: "预览播放头" });
    fireEvent.keyDown(slider, { code: "Space", key: " " });
    fireEvent.keyDown(slider, { code: "ArrowRight", key: "ArrowRight" });

    for (const tag of ["input", "textarea", "select", "button"] as const) {
      const element = document.createElement(tag);
      document.body.append(element);
      fireEvent.keyDown(element, { code: "Space", key: " " });
      fireEvent.keyDown(element, { code: "ArrowRight", key: "ArrowRight" });
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    fireEvent.keyDown(editable, { code: "Space", key: " " });
    fireEvent.keyDown(editable, { code: "ArrowRight", key: "ArrowRight" });

    expect(runtime.play).not.toHaveBeenCalled();
    expect(runtime.step).not.toHaveBeenCalled();
  });
});

describe("PreviewPanel metrics disclosure", () => {
  beforeEach(() => {
    runtimeMocks.reset();
  });

  afterEach(() => {
    cleanup();
  });

  it("switches the preview stage between the supported aspect ratios", async () => {
    await renderReadyPreview();

    const stage = screen.getByTestId("preview-stage");
    expect(stage.getAttribute("data-preview-aspect-ratio")).toBe("16:9");
    expect(stage.style.getPropertyValue("--preview-aspect-ratio")).toBe(
      "16 / 9",
    );

    for (const [label, cssValue] of [
      ["9:16", "9 / 16"],
      ["4:3", "4 / 3"],
      ["1:1", "1 / 1"],
      ["3:4", "3 / 4"],
      ["16:9", "16 / 9"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(stage.getAttribute("data-preview-aspect-ratio")).toBe(label);
      expect(stage.style.getPropertyValue("--preview-aspect-ratio")).toBe(
        cssValue,
      );
      expect(
        screen
          .getByRole("button", { name: label })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    }
  });

  it("defaults to expanded metrics and collapses to a compact live summary", async () => {
    await renderReadyPreview();

    const toggle = screen.getByTestId("preview-metrics-toggle");
    const details = document.getElementById(
      "preview-metrics-details",
    ) as HTMLDListElement;
    const summary = screen.getByTestId("preview-metrics-summary");

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(details.hidden).toBe(true);
    expect(summary.textContent).toContain("Source");
    expect(summary.textContent).toContain("asset: source fallback");
    expect(summary.textContent).toContain("FPS 0");
    expect(summary.textContent).toContain("JS Heap N/A");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details.hidden).toBe(false);
  });

  it("renders memory and resource health metrics in a dedicated row with page heap semantics", async () => {
    runtimeMocks.heapSample = {
      available: true,
      jsHeapSizeLimit: 4 * 1024 * 1024 * 1024,
      totalJSHeapSize: 2 * 1024 * 1024,
      usedJSHeapSize: 1024 * 1024,
    };
    runtimeMocks.storageSample = {
      available: true,
      quotaBytes: 10 * 1024 * 1024,
      usageBytes: 3 * 1024 * 1024,
    };
    runtimeMocks.activeResources = 5;
    runtimeMocks.activeAudioSources = 3;
    runtimeMocks.activeVideoLayers = 2;
    runtimeMocks.activeVideoFrames = 2;
    runtimeMocks.videoQueueStats = {
      active: 2,
      activePeak: 3,
      backpressureCount: 7,
      concurrency: 2,
      highWatermark: 4,
      queued: 1,
      queuedPeak: 5,
    };
    runtimeMocks.audioQueueStats = {
      active: 1,
      activePeak: 2,
      backpressureCount: 3,
      concurrency: 1,
      highWatermark: 2,
      queued: 0,
      queuedPeak: 1,
    };

    await renderReadyPreview();

    const details = document.getElementById(
      "preview-metrics-details",
    ) as HTMLDListElement;
    const healthRow = screen.getByTestId("preview-health-row");

    expect(healthRow.parentElement).toBe(details);
    expect(healthRow.classList).toContain("preview-panel__metrics-health");
    await waitFor(() =>
      expect(screen.getByTestId("runtime-storage").textContent).toContain(
        "usage 3.0 MiB / quota 10.0 MiB",
      ),
    );
    expect(screen.getByTestId("runtime-js-heap").textContent).toContain(
      "页面 JS Heap used 1.0 MiB · total 2.0 MiB · limit 4.00 GiB",
    );
    expect(screen.getByTestId("runtime-js-heap").textContent).toContain(
      "非系统内存 · Worker heap N/A",
    );
    expect(screen.getByTestId("active-resources").textContent).toContain(
      "活跃资源 5 · Video Layers 2 · Audio Sources 3 · VideoFrame 2",
    );
    expect(
      screen
        .getByLabelText("预览指标")
        .closest(".preview-panel")
        ?.getAttribute("data-active-audio-sources"),
    ).toBe("3");
    expect(screen.getByTestId("runtime-video-decoder").textContent).toContain(
      "Video Decode 2/1 · peak 3/5 · HWM 4 · bp 7",
    );
    expect(screen.getByTestId("runtime-audio-decoder").textContent).toContain(
      "Audio Decode 1/0 · peak 2/1 · HWM 2 · bp 3",
    );
  });

  it("keeps unavailable memory and resource metrics as N/A without inferring worker heap", async () => {
    await renderReadyPreview();

    expect(screen.getByTestId("runtime-js-heap").textContent).toContain(
      "页面 JS Heap N/A",
    );
    expect(screen.getByTestId("runtime-js-heap").textContent).toContain(
      "Worker heap N/A",
    );
    expect(screen.getByTestId("runtime-storage").textContent).toContain(
      "Storage N/A",
    );
    expect(screen.getByTestId("runtime-audio-decoder").textContent).toContain(
      "Audio Decode N/A",
    );
    expect(screen.getByTestId("preview-metrics-summary").textContent).toContain(
      "JS Heap N/A",
    );
  });
});
