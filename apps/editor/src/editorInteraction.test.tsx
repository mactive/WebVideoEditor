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
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { Inspector } from "./inspector/Inspector";
import { Timeline } from "./timeline/Timeline";

vi.mock("./capabilities", () => ({
  detectCapabilities: vi.fn(async () => ({
    generatedAt: "2026-08-09T00:00:00.000Z",
    results: [],
  })),
  getActionAvailability: vi.fn(() => [
    {
      enabled: true,
      id: "import",
      label: "导入",
      missing: [],
      reason: "ok",
    },
    {
      enabled: true,
      id: "preview",
      label: "预览",
      missing: [],
      reason: "ok",
    },
    {
      enabled: true,
      id: "export",
      label: "导出",
      missing: [],
      reason: "ok",
    },
    {
      enabled: false,
      id: "sharedMemory",
      label: "共享内存",
      missing: ["sharedArrayBuffer"],
      reason: "disabled in test",
    },
  ]),
  logCapabilityReport: vi.fn(),
}));

vi.mock("./export/ExportPanel", () => ({
  ExportPanel: () => <section aria-label="mock export" />,
}));

vi.mock("./logs/LogPanel", () => ({
  LogPanel: () => <section aria-label="mock logs" />,
}));

vi.mock("./media/MediaPanel", () => ({
  MediaPanel: ({
    onAddToTimeline,
    onAssetImported,
  }: {
    onAddToTimeline?: (
      assetId: string,
      context: {
        assetName: string;
        cacheStatus: "hit" | "miss" | "pending";
        isLongVideo: boolean;
        previewSource: "proxy" | "source";
        proxyStatus: "not-started";
        risk: string;
      },
      options: { kind: "audio" | "video"; placement: "append" | "playhead" },
    ) => void;
    onAssetImported?: (...args: unknown[]) => void;
  }) => {
    const asset = {
      durationUs: 10_000_000,
      fingerprint: "app-asset",
      frameRate: 30,
      hasAudio: true,
      height: 720,
      id: "app-asset",
      name: "app.mp4",
      source: { kind: "test-asset", name: "app.mp4", size: 100 },
      width: 1280,
    };
    const context = {
      assetName: "app.mp4",
      cacheStatus: "pending",
      isLongVideo: false,
      previewSource: "source",
      proxyStatus: "not-started",
      risk: "test",
    } as const;
    const probeResult = {
      audioTracks: [
        {
          channels: 2,
          codec: "aac",
          profile: "LC",
          sampleRate: 48_000,
          trackId: 1,
        },
      ],
      durationSec: 10,
      fingerprint: "app-asset",
      primaryAudioTrackId: 1,
      primaryVideoTrackId: 0,
      read: {
        adapter: "fetch",
        mode: "stream",
        readRatio: 1,
        uniqueBytesRead: 100,
      },
      source: { kind: "test-asset", name: "app.mp4", size: 100 },
      videoTracks: [
        {
          codec: "avc1",
          displayHeight: 720,
          displayWidth: 1280,
          frameRate: 30,
          profile: "baseline",
          rotation: 0,
          trackId: 0,
        },
      ],
      excludedVideoTracks: [],
    };
    return (
      <section aria-label="mock media">
        <button
          onClick={() => onAssetImported?.(asset, probeResult, asset.source)}
          type="button"
        >
          mock import asset
        </button>
        <button
          onClick={() =>
            onAddToTimeline?.("app-asset", context, {
              kind: "video",
              placement: "playhead",
            })
          }
          type="button"
        >
          mock add video playhead
        </button>
        <button
          onClick={() =>
            onAddToTimeline?.("app-asset", context, {
              kind: "audio",
              placement: "playhead",
            })
          }
          type="button"
        >
          mock add audio playhead
        </button>
        <button
          onClick={() =>
            onAddToTimeline?.("app-asset", context, {
              kind: "video",
              placement: "append",
            })
          }
          type="button"
        >
          mock append video
        </button>
      </section>
    );
  },
}));

vi.mock("./preview/PreviewPanel", () => ({
  PreviewPanel: ({
    onPlayheadChange,
    playheadUs,
  }: {
    onPlayheadChange?: (playheadUs: number) => void;
    playheadUs: number;
  }) => (
    <section aria-label="mock preview">
      <span data-testid="preview-playhead">{playheadUs}</span>
      <button onClick={() => onPlayheadChange?.(2_000_000)} type="button">
        mock seek 2s
      </button>
    </section>
  ),
}));

vi.mock("./audio/SyncDebugPanel", () => ({
  SyncDebugPanel: () => <section aria-label="mock sync" />,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function projectFixture(): ProjectDocument {
  const project = createProjectDocument({
    id: "component-test",
    name: "Component test",
    now: "2026-08-09T00:00:00.000Z",
  });
  project.assets.push({
    durationUs: 10_000_000,
    fingerprint: "asset",
    frameRate: 30,
    hasAudio: true,
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
  project.texts.push({
    color: "#ffffff",
    endUs: 5_000_000,
    fontSize: 48,
    id: "title",
    rotationDeg: 0,
    scale: 1,
    startUs: 0,
    text: "Title",
    trackId: "text-track",
    x: 0.5,
    y: 0.2,
  });
  return project;
}

function addSecondVideoTrack(project: ProjectDocument): ProjectDocument {
  project.tracks.push({
    id: "video-track-2",
    kind: "video",
    locked: false,
    muted: false,
    name: "视频 2",
    order: 3,
  });
  project.clips.push({
    assetId: "asset",
    effects: [],
    id: "clip-2",
    sourceEndUs: 5_000_000,
    sourceStartUs: 0,
    timelineStartUs: 0,
    trackId: "video-track-2",
  });
  return project;
}

function addSecondAudioTrack(project: ProjectDocument): ProjectDocument {
  project.tracks.push({
    id: "audio-track-2",
    kind: "audio",
    locked: false,
    muted: false,
    name: "音频 2",
    order: 3,
  });
  project.clips.push({
    assetId: "asset",
    effects: [],
    id: "audio-clip-2",
    sourceEndUs: 5_000_000,
    sourceStartUs: 0,
    timelineStartUs: 0,
    trackId: "audio-track-2",
  });
  return project;
}

function firePointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove",
  init: { clientX: number; pointerId: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(target, event);
}

describe("editor interactions", () => {
  it("routes timeline selection, playhead, and toolbar actions", () => {
    const onAddTitle = vi.fn();
    const onAddAudioTrack = vi.fn();
    const onPlayheadChange = vi.fn();
    const onSelectClip = vi.fn();
    const onSelectTargetAudioTrack = vi.fn();
    const onSelectTargetVideoTrack = vi.fn();
    render(
      <Timeline
        canRedo={false}
        canUndo
        onAddAudioTrack={onAddAudioTrack}
        onAddTitle={onAddTitle}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={onPlayheadChange}
        onRedo={vi.fn()}
        onSelectClip={onSelectClip}
        onSelectTargetAudioTrack={onSelectTargetAudioTrack}
        onSelectTargetVideoTrack={onSelectTargetVideoTrack}
        onSelectText={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={projectFixture()}
        selectedClipId={null}
        selectedTextId={null}
        targetAudioTrackId="audio-track"
        targetVideoTrackId="video-track"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "视频片段 test.mp4" }));
    fireEvent.change(screen.getByRole("slider", { name: "时间线播放头" }), {
      target: { value: "2000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加标题" }));
    fireEvent.click(screen.getByRole("button", { name: "新增音频轨" }));

    expect(onSelectClip).toHaveBeenCalledWith("clip");
    expect(onSelectTargetVideoTrack).toHaveBeenCalledWith("video-track");
    expect(onPlayheadChange).toHaveBeenCalledWith(2_000_000);
    expect(onAddTitle).toHaveBeenCalledOnce();
    expect(onAddAudioTrack).toHaveBeenCalledOnce();
    expect(screen.getByTestId("audio-track").textContent).not.toContain(
      "test.mp4",
    );
  });

  it("renders ordered video tracks and selects the target track", () => {
    const onAddVideoTrack = vi.fn();
    const onSelectTargetVideoTrack = vi.fn();
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={onAddVideoTrack}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={onSelectTargetVideoTrack}
        onSelectText={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={addSecondVideoTrack(projectFixture())}
        selectedClipId={null}
        selectedTextId={null}
        targetAudioTrackId="audio-track"
        targetVideoTrackId="video-track-2"
      />,
    );

    const trackButtons = screen.getAllByRole("button", { name: /V\d 视频/ });
    expect(trackButtons.map((button) => button.textContent)).toEqual([
      "V1 视频",
      "V2 视频 2",
    ]);
    expect(trackButtons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("video-track-video-track").textContent).toContain(
      "test.mp4",
    );
    expect(
      screen.getByTestId("video-track-video-track-2").textContent,
    ).toContain("test.mp4");

    fireEvent.click(screen.getByRole("button", { name: "新增视频轨" }));
    fireEvent.click(screen.getByRole("button", { name: "V1 视频" }));

    expect(onAddVideoTrack).toHaveBeenCalledOnce();
    expect(onSelectTargetVideoTrack).toHaveBeenCalledWith("video-track");
  });

  it("renders and selects target audio tracks independently", () => {
    const onAddAudioTrack = vi.fn();
    const onSelectClip = vi.fn();
    const onSelectTargetAudioTrack = vi.fn();
    const { container } = render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={onAddAudioTrack}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onSelectClip={onSelectClip}
        onSelectTargetAudioTrack={onSelectTargetAudioTrack}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={addSecondAudioTrack(projectFixture())}
        selectedClipId={null}
        selectedTextId={null}
        targetAudioTrackId="audio-track-2"
        targetVideoTrackId="video-track"
      />,
    );

    expect(
      Array.from(container.querySelectorAll(".timeline__label")).map(
        (label) => label.textContent,
      ),
    ).toEqual(["V1 视频", "A1 音频", "T1 文字", "A2 音频 2"]);
    const audioButtons = screen.getAllByRole("button", { name: /A\d 音频/ });
    expect(audioButtons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("audio-track").textContent).not.toContain(
      "test.mp4",
    );
    expect(
      screen.getByTestId("audio-track-audio-track-2").textContent,
    ).toContain("test.mp4");

    fireEvent.click(screen.getByRole("button", { name: "新增音频轨" }));
    fireEvent.click(screen.getByRole("button", { name: "A1 音频" }));
    fireEvent.click(screen.getByRole("button", { name: "音频片段 test.mp4" }));

    expect(onAddAudioTrack).toHaveBeenCalledOnce();
    expect(onSelectTargetAudioTrack).toHaveBeenCalledWith("audio-track");
    expect(onSelectTargetAudioTrack).toHaveBeenCalledWith("audio-track-2");
    expect(onSelectClip).toHaveBeenCalledWith("audio-clip-2");
  });

  it("drags clips with boundaries scoped to the source track", () => {
    const project = projectFixture();
    project.clips = [
      {
        assetId: "asset",
        effects: [],
        id: "audio-1",
        sourceEndUs: 2_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "audio-track",
      },
      {
        assetId: "asset",
        effects: [],
        id: "audio-2",
        sourceEndUs: 2_000_000,
        sourceStartUs: 0,
        timelineStartUs: 3_000_000,
        trackId: "audio-track",
      },
      {
        assetId: "asset",
        effects: [],
        id: "video-overlap",
        sourceEndUs: 2_000_000,
        sourceStartUs: 0,
        timelineStartUs: 1_000_000,
        trackId: "video-track",
      },
    ];
    const onEdit = vi.fn();
    const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 42,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onSplit={vi.fn()}
          onUndo={vi.fn()}
          playheadUs={0}
          project={project}
          selectedClipId={null}
          selectedTextId={null}
          targetAudioTrackId="audio-track"
          targetVideoTrackId="video-track"
        />,
      );

      const firstAudioClip = screen.getAllByRole("button", {
        name: "音频片段 test.mp4",
      })[0];
      firePointerEvent(firstAudioClip!, "pointerdown", {
        clientX: 0,
        pointerId: 1,
      });
      firePointerEvent(firstAudioClip!, "pointermove", {
        clientX: 50,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: "audio-1",
          timelineStartUs: 1_000_000,
          type: "clip.move",
        }),
        expect.any(String),
      );
    } finally {
      if (originalSetPointerCapture) {
        Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
          configurable: true,
          value: originalSetPointerCapture,
        });
      } else {
        delete (HTMLElement.prototype as Partial<HTMLElement>)
          .setPointerCapture;
      }
    }
  });

  it("adds the same asset to target video and audio tracks at the playhead", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "mock import asset" }));
    fireEvent.click(screen.getByRole("button", { name: "mock seek 2s" }));
    fireEvent.click(
      screen.getByRole("button", { name: "mock add video playhead" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "mock add audio playhead" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "mock append video" }));
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.clips).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            assetId: "app-asset",
            timelineStartUs: 2_000_000,
            trackId: "video-track",
          }),
          expect.objectContaining({
            assetId: "app-asset",
            timelineStartUs: 2_000_000,
            trackId: "audio-track",
          }),
          expect.objectContaining({
            assetId: "app-asset",
            timelineStartUs: 12_000_000,
            trackId: "video-track",
          }),
        ]),
      );
    });
  });

  it("emits text and filter commands from Inspector", () => {
    const onExecute = vi.fn();
    const project = projectFixture();
    const { rerender } = render(
      <Inspector
        onExecute={onExecute}
        project={project}
        selectedClipId={null}
        selectedTextId="title"
      />,
    );

    fireEvent.change(screen.getByLabelText("标题文本"), {
      target: { value: "Task 10" },
    });
    expect(onExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { text: "Task 10" },
        textId: "title",
        type: "text.update",
      }),
      expect.stringContaining("inspector-text-title-text"),
    );

    rerender(
      <Inspector
        onExecute={onExecute}
        project={project}
        selectedClipId="clip"
        selectedTextId={null}
      />,
    );
    fireEvent.change(screen.getByLabelText("滤镜类型"), {
      target: { value: "vintage" },
    });
    expect(onExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clipId: "clip",
        effect: expect.objectContaining({ kind: "vintage" }),
        type: "effect.set",
      }),
      expect.any(String),
    );
    fireEvent.change(screen.getByLabelText("片段旋转"), {
      target: { value: "18" },
    });
    expect(onExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clipId: "clip",
        transform: expect.objectContaining({ rotationDeg: 18 }),
        type: "clip.transform",
      }),
      expect.any(String),
    );
  });
});
