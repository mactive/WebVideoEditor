import {
  assertPureJson,
  createProjectDocument,
  type ProjectDocument,
} from "@web-video-editor/domain";
import { describe, expect, it } from "vitest";

import { ProjectCommandController } from "./commandController";
import { clipSelected, playheadChanged } from "./sessionSlice";
import { createEditorStore } from "./store";

function projectWithClip(): ProjectDocument {
  const project = createProjectDocument({
    id: "store-project",
    name: "Store 测试",
    now: "2026-08-09T00:00:00.000Z",
  });
  project.assets.push({
    id: "asset-1",
    name: "test.mp4",
    fingerprint: "sha256:test",
    durationUs: 10_000_000,
    width: 1920,
    height: 1080,
    frameRate: 30,
    hasAudio: true,
    source: {
      kind: "test-asset",
      name: "test.mp4",
      size: 1024,
    },
  });
  project.clips.push({
    id: "clip-1",
    assetId: "asset-1",
    trackId: "video-track",
    timelineStartUs: 0,
    sourceStartUs: 0,
    sourceEndUs: 5_000_000,
    effects: [],
  });
  return project;
}

describe("editor store", () => {
  it("keeps Project and Session as pure JSON", () => {
    const store = createEditorStore(projectWithClip());

    store.dispatch(playheadChanged(1_500_000));
    store.dispatch(clipSelected("clip-1"));

    expect(() => assertPureJson(store.getState())).not.toThrow();
    expect(store.getState().session).toEqual(
      expect.objectContaining({
        playheadUs: 1_500_000,
        selectedClipId: "clip-1",
      }),
    );
  });

  it("commits formal edits only through the Command Bus controller", () => {
    const initial = projectWithClip();
    const store = createEditorStore(initial);
    const controller = new ProjectCommandController(store, {
      now: () => "2026-08-09T01:00:00.000Z",
    });

    controller.execute({
      type: "clip.trim",
      clipId: "clip-1",
      timelineStartUs: 1_000_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 4_000_000,
    });

    expect(store.getState().project.document.clips[0]).toEqual(
      expect.objectContaining({
        timelineStartUs: 1_000_000,
        sourceStartUs: 1_000_000,
        sourceEndUs: 4_000_000,
      }),
    );

    controller.undo();
    expect(store.getState().project.document).toEqual(initial);
    controller.redo();
    expect(store.getState().project.document.revision).toBe(1);
  });
});
