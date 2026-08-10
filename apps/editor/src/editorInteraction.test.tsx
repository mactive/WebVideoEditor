// @vitest-environment jsdom

import {
  createProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Inspector } from "./inspector/Inspector";
import { Timeline } from "./timeline/Timeline";

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

describe("editor interactions", () => {
  it("routes timeline selection, playhead, and toolbar actions", () => {
    const onAddTitle = vi.fn();
    const onPlayheadChange = vi.fn();
    const onSelectClip = vi.fn();
    render(
      <Timeline
        canRedo={false}
        canUndo
        onAddTitle={onAddTitle}
        onDelete={vi.fn()}
        onEdit={vi.fn()}
        onPlayheadChange={onPlayheadChange}
        onRedo={vi.fn()}
        onSelectClip={onSelectClip}
        onSelectText={vi.fn()}
        onSplit={vi.fn()}
        onUndo={vi.fn()}
        playheadUs={0}
        project={projectFixture()}
        selectedClipId={null}
        selectedTextId={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "视频片段 test.mp4" }));
    fireEvent.change(screen.getByRole("slider", { name: "时间线播放头" }), {
      target: { value: "2000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加标题" }));

    expect(onSelectClip).toHaveBeenCalledWith("clip");
    expect(onPlayheadChange).toHaveBeenCalledWith(2_000_000);
    expect(onAddTitle).toHaveBeenCalledOnce();
    expect(screen.getByTestId("audio-track").textContent).toContain("test.mp4");
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
