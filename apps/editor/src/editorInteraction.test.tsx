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
    order: Math.max(...project.tracks.map((track) => track.order)) + 1,
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

function addEmptySecondVideoTrack(project: ProjectDocument): ProjectDocument {
  project.tracks.push({
    id: "video-track-2",
    kind: "video",
    locked: false,
    muted: false,
    name: "视频 2",
    order: Math.max(...project.tracks.map((track) => track.order)) + 1,
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
    order: Math.max(...project.tracks.map((track) => track.order)) + 1,
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

function addEmptySecondAudioTrack(project: ProjectDocument): ProjectDocument {
  project.tracks.push({
    id: "audio-track-2",
    kind: "audio",
    locked: false,
    muted: false,
    name: "音频 2",
    order: Math.max(...project.tracks.map((track) => track.order)) + 1,
  });
  return project;
}

function addSecondTextTrack(project: ProjectDocument): ProjectDocument {
  project.tracks.push({
    id: "text-track-2",
    kind: "text",
    locked: false,
    muted: false,
    name: "文字 2",
    order: Math.max(...project.tracks.map((track) => track.order)) + 1,
  });
  return project;
}

function dataTransferMock() {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    getData: vi.fn((type: string) => values.get(type) ?? ""),
    setData: vi.fn((type: string, value: string) => {
      values.set(type, value);
    }),
  };
}

function firePointerEvent(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientX: number; clientY?: number; pointerId: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: init.clientX });
  if (init.clientY !== undefined) {
    Object.defineProperty(event, "clientY", { value: init.clientY });
  }
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  fireEvent(target, event);
}

function mockPointerCapture() {
  const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  return () => {
    if (originalSetPointerCapture) {
      Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
        configurable: true,
        value: originalSetPointerCapture,
      });
    } else {
      delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
    }
  };
}

function setLaneRect(testId: string, top: number, bottom: number) {
  const lane = screen.getByTestId(testId) as HTMLElement;
  Object.defineProperty(lane, "getBoundingClientRect", {
    configurable: true,
    value: vi.fn(() => ({
      bottom,
      height: bottom - top,
      left: 0,
      right: 1_000,
      top,
      width: 1_000,
      x: 0,
      y: top,
      toJSON: () => ({}),
    })),
  });
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
        onDeleteTrack={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={onPlayheadChange}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={onSelectClip}
        onSelectTargetAudioTrack={onSelectTargetAudioTrack}
        onSelectTargetVideoTrack={onSelectTargetVideoTrack}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
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

  it("sets timeline duration from presets and exact seconds input", () => {
    const onTimelineDurationChange = vi.fn();
    const project = projectFixture();
    project.clips[0]!.timelineStartUs = 10_000_000;
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={onTimelineDurationChange}
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

    fireEvent.click(screen.getByRole("button", { name: "3min" }));
    fireEvent.change(screen.getByLabelText("时间线总时长（秒）"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用总长" }));

    expect(onTimelineDurationChange).toHaveBeenNthCalledWith(1, 180_000_000);
    expect(onTimelineDurationChange).toHaveBeenNthCalledWith(2, 1_000_000);
    expect(screen.getByRole("status").textContent).toContain("内容末尾为");
  });

  it("zooms timeline pixels without emitting project edits", () => {
    const onEdit = vi.fn();
    const onTimelineDurationChange = vi.fn();
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={vi.fn()}
        onEdit={onEdit}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={onTimelineDurationChange}
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

    const clip = screen.getByRole("button", { name: "视频片段 test.mp4" });
    expect((clip as HTMLElement).style.width).toBe("400px");

    fireEvent.change(screen.getByRole("slider", { name: "时间线缩放" }), {
      target: { value: "160" },
    });

    expect((clip as HTMLElement).style.width).toBe("800px");
    expect(onEdit).not.toHaveBeenCalled();
    expect(onTimelineDurationChange).not.toHaveBeenCalled();
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
        onDeleteTrack={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={onSelectTargetVideoTrack}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
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

    const trackButtons = screen.getAllByRole("button", {
      name: /^V\d 视频/,
    });
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
        onDeleteTrack={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={onSelectClip}
        onSelectTargetAudioTrack={onSelectTargetAudioTrack}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
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
    const audioButtons = screen.getAllByRole("button", {
      name: /^A\d 音频/,
    });
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

  it("emits a complete track reorder command when dragging track headers", () => {
    const project = addSecondTextTrack(
      addSecondAudioTrack(addSecondVideoTrack(projectFixture())),
    );
    const onReorderTracks = vi.fn();
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={onReorderTracks}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
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

    const dataTransfer = dataTransferMock();
    fireEvent.dragStart(screen.getByLabelText("轨道头 V2 视频 2"), {
      dataTransfer,
    });
    fireEvent.dragOver(screen.getByLabelText("轨道头 T1 文字"), {
      dataTransfer,
    });
    fireEvent.drop(screen.getByLabelText("轨道头 T1 文字"), {
      dataTransfer,
    });

    expect(screen.getByLabelText("轨道头 A2 音频 2")).toHaveProperty(
      "draggable",
      true,
    );
    expect(screen.getByLabelText("轨道头 T2 文字 2")).toHaveProperty(
      "draggable",
      true,
    );
    expect(onReorderTracks).toHaveBeenCalledWith([
      "video-track",
      "audio-track",
      "video-track-2",
      "text-track",
      "audio-track-2",
      "text-track-2",
    ]);
  });

  it("deletes empty tracks without confirmation", () => {
    const onDeleteTrack = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={onDeleteTrack}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={addSecondAudioTrack(projectFixture())}
        selectedClipId={null}
        selectedTextId={null}
        targetAudioTrackId="audio-track"
        targetVideoTrackId="video-track"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除轨道 A1 音频" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(onDeleteTrack).toHaveBeenCalledWith("audio-track", false);
  });

  it("does not delete a content track when confirmation is cancelled", () => {
    const onDeleteTrack = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={onDeleteTrack}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={addSecondVideoTrack(projectFixture())}
        selectedClipId={null}
        selectedTextId={null}
        targetAudioTrackId="audio-track"
        targetVideoTrackId="video-track"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除轨道 V2 视频 2" }));

    expect(window.confirm).toHaveBeenCalled();
    expect(onDeleteTrack).not.toHaveBeenCalled();
  });

  it("deletes a content track with cascade after confirmation", () => {
    const onDeleteTrack = vi.fn();
    const project = addSecondTextTrack(projectFixture());
    project.texts[0]!.trackId = "text-track-2";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <Timeline
        canRedo={false}
        canUndo={false}
        onAddAudioTrack={vi.fn()}
        onAddTitle={vi.fn()}
        onAddVideoTrack={vi.fn()}
        onDelete={vi.fn()}
        onDeleteTrack={onDeleteTrack}
        onEdit={vi.fn()}
        onPlayheadChange={vi.fn()}
        onRedo={vi.fn()}
        onReorderTracks={vi.fn()}
        onSelectClip={vi.fn()}
        onSelectTargetAudioTrack={vi.fn()}
        onSelectTargetVideoTrack={vi.fn()}
        onSelectText={vi.fn()}
        onTimelineDurationChange={vi.fn()}
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

    fireEvent.click(screen.getByRole("button", { name: "删除轨道 T2 文字 2" }));

    expect(onDeleteTrack).toHaveBeenCalledWith("text-track-2", true);
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
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
          timelineStartUs: 625_000,
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

  it("moves video clips across video tracks", () => {
    const project = addEmptySecondVideoTrack(projectFixture());
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("video-track-video-track-2", 50, 92);

      const clip = screen.getByRole("button", { name: "视频片段 test.mp4" });
      firePointerEvent(clip, "pointerdown", {
        clientX: 0,
        clientY: 10,
        pointerId: 1,
      });
      firePointerEvent(clip, "pointermove", {
        clientX: 80,
        clientY: 60,
        pointerId: 1,
      });
      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("video-track-video-track-2", 50, 92);
      firePointerEvent(
        screen.getByRole("button", { name: "视频片段 test.mp4" }),
        "pointermove",
        {
          clientX: 160,
          clientY: 60,
          pointerId: 1,
        },
      );

      expect(onEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clipId: "clip",
          timelineStartUs: 2_000_000,
          trackId: "video-track-2",
          type: "clip.move",
        }),
        expect.any(String),
      );
      expect(onEdit.mock.calls[0]?.[1]).toBe(onEdit.mock.calls[1]?.[1]);
    } finally {
      restorePointerCapture();
    }
  });

  it("moves audio clips across audio tracks", () => {
    const project = addEmptySecondAudioTrack(projectFixture());
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
    ];
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
      setLaneRect("audio-track", 50, 92);
      setLaneRect("audio-track-audio-track-2", 100, 142);

      const clip = screen.getByRole("button", { name: "音频片段 test.mp4" });
      firePointerEvent(clip, "pointerdown", {
        clientX: 0,
        clientY: 60,
        pointerId: 1,
      });
      firePointerEvent(clip, "pointermove", {
        clientX: 80,
        clientY: 110,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: "audio-1",
          timelineStartUs: 1_000_000,
          trackId: "audio-track-2",
          type: "clip.move",
        }),
        expect.any(String),
      );
    } finally {
      restorePointerCapture();
    }
  });

  it("trims video and audio clips with visible handles", () => {
    const project = projectFixture();
    project.clips.push({
      assetId: "asset",
      effects: [],
      id: "audio-1",
      sourceEndUs: 5_000_000,
      sourceStartUs: 0,
      timelineStartUs: 0,
      trackId: "audio-track",
    });
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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

      fireEvent.change(screen.getByRole("slider", { name: "时间线缩放" }), {
        target: { value: "160" },
      });
      const videoClip = screen.getByRole("button", {
        name: "视频片段 test.mp4",
      });
      const videoTrimStart = screen.getByLabelText("裁剪 视频 test.mp4 开头");
      firePointerEvent(videoTrimStart, "pointerdown", {
        clientX: 0,
        pointerId: 1,
      });
      firePointerEvent(videoClip, "pointermove", {
        clientX: 160,
        pointerId: 1,
      });
      firePointerEvent(videoClip, "pointermove", {
        clientX: 320,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clipId: "clip",
          sourceEndUs: 5_000_000,
          sourceStartUs: 2_000_000,
          timelineStartUs: 2_000_000,
          type: "clip.trim",
        }),
        expect.any(String),
      );
      expect(onEdit.mock.calls[0]?.[1]).toBe(onEdit.mock.calls[1]?.[1]);

      const audioClip = screen.getByRole("button", {
        name: "音频片段 test.mp4",
      });
      const audioTrimEnd = screen.getByLabelText("裁剪 音频 test.mp4 结尾");
      firePointerEvent(audioTrimEnd, "pointerdown", {
        clientX: 0,
        pointerId: 2,
      });
      firePointerEvent(audioClip, "pointermove", {
        clientX: -160,
        pointerId: 2,
      });

      expect(onEdit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          clipId: "audio-1",
          sourceEndUs: 4_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
          type: "clip.trim",
        }),
        expect.any(String),
      );
    } finally {
      restorePointerCapture();
    }
  });

  it("clamps trim drags at same-track conflicts and shows the reason", () => {
    const project = projectFixture();
    project.clips = [
      {
        assetId: "asset",
        effects: [],
        id: "clip-1",
        sourceEndUs: 2_000_000,
        sourceStartUs: 0,
        timelineStartUs: 0,
        trackId: "video-track",
      },
      {
        assetId: "asset",
        effects: [],
        id: "clip-2",
        sourceEndUs: 2_000_000,
        sourceStartUs: 0,
        timelineStartUs: 3_000_000,
        trackId: "video-track",
      },
    ];
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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

      const firstClip = screen.getAllByRole("button", {
        name: "视频片段 test.mp4",
      })[0]!;
      firePointerEvent(screen.getAllByLabelText("裁剪 视频 test.mp4 结尾")[0]!, "pointerdown", {
        clientX: 0,
        pointerId: 1,
      });
      firePointerEvent(firstClip, "pointermove", {
        clientX: 200,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: "clip-1",
          sourceEndUs: 3_000_000,
          type: "clip.trim",
        }),
        expect.any(String),
      );
      expect(screen.getByRole("status").textContent).toContain(
        "同轨相邻片段",
      );
    } finally {
      restorePointerCapture();
    }
  });

  it("rejects dragging media clips to a different track kind", () => {
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("audio-track", 50, 92);

      const clip = screen.getByRole("button", { name: "视频片段 test.mp4" });
      firePointerEvent(clip, "pointerdown", {
        clientX: 0,
        clientY: 10,
        pointerId: 1,
      });
      firePointerEvent(clip, "pointermove", {
        clientX: 80,
        clientY: 60,
        pointerId: 1,
      });

      expect(onEdit).not.toHaveBeenCalled();
      expect(screen.getByRole("status").textContent).toContain(
        "不能将视频片段移动到音频轨",
      );
    } finally {
      restorePointerCapture();
    }
  });

  it("clamps cross-track clip moves when the target track has conflicts", () => {
    const project = addSecondVideoTrack(projectFixture());
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("video-track-video-track-2", 50, 92);

      const clip = screen.getAllByRole("button", {
        name: "视频片段 test.mp4",
      })[0]!;
      firePointerEvent(clip, "pointerdown", {
        clientX: 0,
        clientY: 10,
        pointerId: 1,
      });
      firePointerEvent(clip, "pointermove", {
        clientX: 80,
        clientY: 60,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          clipId: "clip",
          timelineStartUs: 5_000_000,
          trackId: "video-track-2",
          type: "clip.move",
        }),
        expect.any(String),
      );
      expect(screen.getByRole("status").textContent).toContain("时间冲突");
    } finally {
      restorePointerCapture();
    }
  });

  it("moves text clips across text tracks", () => {
    const project = addSecondTextTrack(projectFixture());
    const onEdit = vi.fn();
    const restorePointerCapture = mockPointerCapture();

    try {
      render(
        <Timeline
          canRedo={false}
          canUndo={false}
          onAddAudioTrack={vi.fn()}
          onAddTitle={vi.fn()}
          onAddVideoTrack={vi.fn()}
          onDelete={vi.fn()}
          onDeleteTrack={vi.fn()}
          onEdit={onEdit}
          onPlayheadChange={vi.fn()}
          onRedo={vi.fn()}
          onReorderTracks={vi.fn()}
          onSelectClip={vi.fn()}
          onSelectTargetAudioTrack={vi.fn()}
          onSelectTargetVideoTrack={vi.fn()}
          onSelectText={vi.fn()}
          onTimelineDurationChange={vi.fn()}
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
      setLaneRect("text-track", 100, 142);
      setLaneRect("text-track-text-track-2", 150, 192);

      const text = screen.getByRole("button", { name: "Title" });
      firePointerEvent(text, "pointerdown", {
        clientX: 0,
        clientY: 110,
        pointerId: 1,
      });
      firePointerEvent(text, "pointermove", {
        clientX: 160,
        clientY: 160,
        pointerId: 1,
      });

      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          patch: {
            endUs: 7_000_000,
            startUs: 2_000_000,
            trackId: "text-track-2",
          },
          textId: "title",
          type: "text.update",
        }),
        expect.any(String),
      );
    } finally {
      restorePointerCapture();
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

  it("keeps a configured long timeline duration after adding a short asset", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "10min" }));
    fireEvent.click(screen.getByRole("button", { name: "mock import asset" }));
    fireEvent.click(
      screen.getByRole("button", { name: "mock add video playhead" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.timeline.durationUs).toBe(600_000_000);
      expect(project.clips[0]).toEqual(
        expect.objectContaining({
          assetId: "app-asset",
          timelineStartUs: 0,
        }),
      );
    });
  });

  it("keeps actual timeline duration at content end when exact input is shorter", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "mock import asset" }));
    fireEvent.click(
      screen.getByRole("button", { name: "mock add video playhead" }),
    );
    fireEvent.change(screen.getByLabelText("时间线总时长（秒）"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用总长" }));
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.timeline.durationUs).toBe(10_000_000);
    });
    expect(screen.getByRole("status").textContent).toContain("内容末尾为");
  });

  it("deletes an empty track through the command bus", async () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "新增音频轨" }));
    fireEvent.click(screen.getByRole("button", { name: "删除轨道 A2 音频 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.tracks.map((track) => track.id)).not.toContain(
        "audio-track-2",
      );
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText("已删除轨道 音频 2")).toBeTruthy();
  });

  it("reorders tracks through the command bus and undo restores order", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "新增视频轨" }));
    const dataTransfer = dataTransferMock();
    fireEvent.dragStart(screen.getByLabelText("轨道头 V2 视频 2"), {
      dataTransfer,
    });
    fireEvent.dragOver(screen.getByLabelText("轨道头 V1 视频"), {
      dataTransfer,
    });
    fireEvent.drop(screen.getByLabelText("轨道头 V1 视频"), {
      dataTransfer,
    });
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      const orderById = new Map(
        project.tracks.map((track) => [track.id, track.order]),
      );
      expect(orderById.get("video-track-2")).toBe(0);
      expect(orderById.get("video-track")).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      const orderById = new Map(
        project.tracks.map((track) => [track.id, track.order]),
      );
      expect(orderById.get("video-track")).toBe(0);
      expect(orderById.get("video-track-2")).toBe(3);
    });
  });

  it("moves clips across tracks through the command bus and undo restores the drag", async () => {
    const project = addEmptySecondVideoTrack(projectFixture());
    const restorePointerCapture = mockPointerCapture();

    try {
      render(<App initialProject={project} />);
      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("video-track-video-track-2", 50, 92);

      const clip = screen.getByRole("button", { name: "视频片段 test.mp4" });
      firePointerEvent(clip, "pointerdown", {
        clientX: 0,
        clientY: 10,
        pointerId: 1,
      });
      firePointerEvent(clip, "pointermove", {
        clientX: 80,
        clientY: 60,
        pointerId: 1,
      });
      fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

      await waitFor(() => {
        const moved = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(moved.clips[0]).toEqual(
          expect.objectContaining({
            timelineStartUs: 1_000_000,
            trackId: "video-track-2",
          }),
        );
      });

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      await waitFor(() => {
        const undone = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(undone.clips[0]).toEqual(
          expect.objectContaining({
            timelineStartUs: 0,
            trackId: "video-track",
          }),
        );
      });

      fireEvent.click(screen.getByRole("button", { name: "Redo" }));

      await waitFor(() => {
        const redone = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(redone.clips[0]).toEqual(
          expect.objectContaining({
            timelineStartUs: 1_000_000,
            trackId: "video-track-2",
          }),
        );
      });
    } finally {
      restorePointerCapture();
    }
  });

  it("selects and moves the right clip after splitting a video clip", async () => {
    const project = addEmptySecondVideoTrack(projectFixture());
    const restorePointerCapture = mockPointerCapture();
    const { container } = render(<App initialProject={project} />);

    try {
      fireEvent.change(screen.getByRole("slider", { name: "时间线播放头" }), {
        target: { value: "2000000" },
      });
      fireEvent.click(screen.getByRole("button", { name: "视频片段 test.mp4" }));
      fireEvent.click(screen.getByRole("button", { name: "播放头分割" }));
      fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

      let rightClipId = "";
      await waitFor(() => {
        const split = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        const rightClip = split.clips.find(
          (clip) =>
            clip.trackId === "video-track" && clip.sourceStartUs === 2_000_000,
        );
        expect(rightClip).toBeTruthy();
        rightClipId = rightClip?.id ?? "";
        expect(
          container
            .querySelector(`[data-clip-id="${rightClipId}"]`)
            ?.getAttribute("aria-selected"),
        ).toBe("true");
      });

      setLaneRect("video-track-video-track", 0, 42);
      setLaneRect("video-track-video-track-2", 50, 92);
      const rightClipElement = container.querySelector(
        `[data-clip-id="${rightClipId}"]`,
      );
      expect(rightClipElement).toBeTruthy();
      firePointerEvent(rightClipElement!, "pointerdown", {
        clientX: 0,
        clientY: 10,
        pointerId: 1,
      });
      firePointerEvent(rightClipElement!, "pointermove", {
        clientX: 80,
        clientY: 60,
        pointerId: 1,
      });

      await waitFor(() => {
        const moved = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(moved.clips.find((clip) => clip.id === rightClipId)).toEqual(
          expect.objectContaining({
            timelineStartUs: 3_000_000,
            trackId: "video-track-2",
          }),
        );
      });

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      await waitFor(() => {
        const undone = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(undone.clips.find((clip) => clip.id === rightClipId)).toEqual(
          expect.objectContaining({
            timelineStartUs: 2_000_000,
            trackId: "video-track",
          }),
        );
      });
    } finally {
      restorePointerCapture();
    }
  });

  it("trims the right audio clip after splitting and supports undo", async () => {
    const project = projectFixture();
    project.clips.push({
      assetId: "asset",
      effects: [],
      id: "audio-1",
      sourceEndUs: 5_000_000,
      sourceStartUs: 0,
      timelineStartUs: 0,
      trackId: "audio-track",
    });
    const restorePointerCapture = mockPointerCapture();
    const { container } = render(<App initialProject={project} />);

    try {
      fireEvent.change(screen.getByRole("slider", { name: "时间线播放头" }), {
        target: { value: "2000000" },
      });
      fireEvent.click(screen.getByRole("button", { name: "音频片段 test.mp4" }));
      fireEvent.click(screen.getByRole("button", { name: "播放头分割" }));
      fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

      let rightClipId = "";
      await waitFor(() => {
        const split = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        const rightClip = split.clips.find(
          (clip) =>
            clip.trackId === "audio-track" && clip.sourceStartUs === 2_000_000,
        );
        expect(rightClip).toBeTruthy();
        rightClipId = rightClip?.id ?? "";
      });

      const rightClipElement = container.querySelector(
        `[data-clip-id="${rightClipId}"]`,
      );
      const trimEnd = rightClipElement?.querySelector(".timeline__trim--end");
      expect(trimEnd).toBeTruthy();
      firePointerEvent(trimEnd!, "pointerdown", {
        clientX: 0,
        pointerId: 1,
      });
      firePointerEvent(rightClipElement!, "pointermove", {
        clientX: -80,
        pointerId: 1,
      });

      await waitFor(() => {
        const trimmed = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(trimmed.clips.find((clip) => clip.id === rightClipId)).toEqual(
          expect.objectContaining({
            sourceEndUs: 4_000_000,
            sourceStartUs: 2_000_000,
          }),
        );
      });

      fireEvent.click(screen.getByRole("button", { name: "Undo" }));

      await waitFor(() => {
        const undone = JSON.parse(
          screen.getByTestId("project-json").textContent ?? "{}",
        ) as ProjectDocument;
        expect(undone.clips.find((clip) => clip.id === rightClipId)).toEqual(
          expect.objectContaining({
            sourceEndUs: 5_000_000,
            sourceStartUs: 2_000_000,
          }),
        );
      });
    } finally {
      restorePointerCapture();
    }
  });

  it("clears deleted selected clips and retargets media tracks after cascade deletion", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "新增视频轨" }));
    fireEvent.click(screen.getByRole("button", { name: "mock import asset" }));
    fireEvent.click(screen.getByRole("button", { name: "mock seek 2s" }));
    fireEvent.click(
      screen.getByRole("button", { name: "mock add video playhead" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "删除轨道 V2 视频 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.tracks.map((track) => track.id)).not.toContain(
        "video-track-2",
      );
      expect(project.clips).toEqual([]);
    });
    expect(
      screen
        .getByRole("button", { name: "V1 视频" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("preview-playhead").textContent).toBe("2000000");
    expect(
      (screen.getByRole("button", { name: "删除" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("已删除轨道 视频 2 及其内容")).toBeTruthy();
  });

  it("clears deleted selected text after cascade deletion", async () => {
    const project = addSecondTextTrack(projectFixture());
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App initialProject={project} />);

    fireEvent.click(screen.getByRole("button", { name: "Title" }));
    fireEvent.click(screen.getByRole("button", { name: "删除轨道 T1 文字" }));
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const nextProject = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(nextProject.tracks.map((track) => track.id)).not.toContain(
        "text-track",
      );
      expect(nextProject.texts).toEqual([]);
    });
    expect(screen.queryByRole("button", { name: "Title" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "删除" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a command bus failure when deleting the last track of a kind", () => {
    const confirm = vi.spyOn(window, "confirm");
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "删除轨道 A1 音频" }));

    expect(confirm).not.toHaveBeenCalled();
    expect(
      screen.getByText("操作未提交：不能删除最后一条音频轨道"),
    ).toBeTruthy();
  });

  it("does not trigger global undo from focused track controls", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "新增音频轨" }));
    const deleteTrackButton = screen.getByRole("button", {
      name: "删除轨道 A2 音频 2",
    });
    deleteTrackButton.focus();
    fireEvent.keyDown(deleteTrackButton, { ctrlKey: true, key: "z" });
    fireEvent.click(screen.getByRole("button", { name: "Project JSON" }));

    await waitFor(() => {
      const project = JSON.parse(
        screen.getByTestId("project-json").textContent ?? "{}",
      ) as ProjectDocument;
      expect(project.tracks.map((track) => track.id)).toContain(
        "audio-track-2",
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
