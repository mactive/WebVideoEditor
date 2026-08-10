import { createProjectDocument } from "@web-video-editor/domain";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  IndexedDbProjectRepository,
  restoreProject,
  startProjectAutosave,
} from "./persistence";
import { ProjectCommandController } from "./commandController";
import { projectCommitted } from "./projectSlice";
import { createEditorStore } from "./store";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("等待 IndexedDB 自动保存超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("IndexedDbProjectRepository", () => {
  it("saves and restores validated Project JSON", async () => {
    const repository = new IndexedDbProjectRepository(
      "repository-test",
      new IDBFactory(),
    );
    const project = createProjectDocument({
      id: "persisted-project",
      name: "持久化工程",
      now: "2026-08-09T00:00:00.000Z",
    });

    await repository.save(project);
    const restored = await repository.load(project.id);

    expect(restored).toEqual(project);
    repository.close();
  });

  it("autosaves revisions and restores them into Redux", async () => {
    const repository = new IndexedDbProjectRepository(
      "autosave-test",
      new IDBFactory(),
    );
    const initial = createProjectDocument({
      id: "autosave-project",
      name: "初始工程",
      now: "2026-08-09T00:00:00.000Z",
    });
    const sourceStore = createEditorStore(initial);
    const stop = startProjectAutosave(sourceStore, repository, 0);
    const changed = {
      ...initial,
      name: "自动保存工程",
      revision: 1,
      updatedAt: "2026-08-09T01:00:00.000Z",
    };

    sourceStore.dispatch(projectCommitted(changed));
    await waitUntil(
      () => sourceStore.getState().session.persistenceStatus === "saved",
    );
    stop();

    const targetStore = createEditorStore(initial);
    const restored = await restoreProject(targetStore, repository, initial.id);

    expect(restored?.name).toBe("自动保存工程");
    expect(targetStore.getState().project.document).toEqual(changed);
    expect(targetStore.getState().session.persistenceStatus).toBe("saved");
    repository.close();
  });

  it("executes the next command from the Redux document restored by IndexedDB", async () => {
    const repository = new IndexedDbProjectRepository(
      "restore-command-test",
      new IDBFactory(),
    );
    const initial = createProjectDocument({
      id: "restore-command-project",
      name: "构造 controller 时的旧工程",
      now: "2026-08-09T00:00:00.000Z",
    });
    const restored = {
      ...initial,
      name: "IndexedDB 恢复工程",
      revision: 7,
      updatedAt: "2026-08-09T07:00:00.000Z",
    };
    await repository.save(restored);

    const store = createEditorStore(initial);
    const controller = new ProjectCommandController(store, {
      now: () => "2026-08-09T08:00:00.000Z",
    });
    await restoreProject(store, repository, initial.id);
    const committed = controller.execute({
      asset: {
        durationUs: 1_000_000,
        fingerprint: "sha256:restored",
        frameRate: 30,
        hasAudio: false,
        height: 720,
        id: "asset-after-restore",
        name: "restored.mp4",
        source: {
          kind: "file",
          name: "restored.mp4",
          size: 1024,
        },
        width: 1280,
      },
      type: "asset.add",
    });

    expect(committed).toEqual(store.getState().project.document);
    expect(committed).toMatchObject({
      name: "IndexedDB 恢复工程",
      revision: 8,
    });
    expect(committed.assets.map((asset) => asset.id)).toEqual([
      "asset-after-restore",
    ]);
    expect(controller.undo()).toEqual(restored);
    expect(store.getState().project.document).toEqual(restored);

    controller.dispose();
    repository.close();
  });
});
