import { createProjectDocument } from "@web-video-editor/domain";
import { describe, expect, it } from "vitest";

import { ProjectCommandController, createEditorStore } from "../store";
import { ClipViewModel } from "./ClipViewModel";

describe("isolated MobX Clip ViewModel", () => {
  it("tracks action and reaction without writing the Redux Project", () => {
    const store = createEditorStore(
      createProjectDocument({
        id: "mobx-isolation",
        name: "MobX isolation",
        now: "2026-08-09T00:00:00.000Z",
      }),
    );
    const controller = new ProjectCommandController(store);
    const viewModel = new ClipViewModel();
    const before = store.getState().project.document;

    viewModel.setX(0.75);
    viewModel.setRotation(20);

    expect(viewModel.snapshot()).toEqual(
      expect.objectContaining({
        actionCount: 2,
        reactionCount: 2,
        rotationDeg: 20,
        x: 0.75,
      }),
    );
    expect(store.getState().project.document).toBe(before);
    expect(store.getState().project.document.revision).toBe(0);

    controller.execute({
      text: {
        color: "#ffffff",
        endUs: 1_000_000,
        fontSize: 48,
        id: "redux-title",
        rotationDeg: 0,
        scale: 1,
        startUs: 0,
        text: "Redux",
        trackId: "text-track",
        x: 0.5,
        y: 0.5,
      },
      type: "text.add",
    });
    expect(store.getState().project.document.revision).toBe(1);
    viewModel.dispose();
  });
});
