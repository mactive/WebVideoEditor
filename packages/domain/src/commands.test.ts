import { describe, expect, it } from "vitest";

import { CommandBus, type CommandEvent } from "./command-bus";
import { applyProjectCommand, type ProjectCommand } from "./commands";
import { createTestProject } from "./test-fixture";

const now = "2026-08-09T01:00:00.000Z";

describe("project commands", () => {
  it("adapts only an empty project canvas to the first asset display size", () => {
    const empty = createTestProject();
    empty.assets = [];
    empty.clips = [];
    const portrait = {
      durationUs: 5_000_000,
      fingerprint: "sha256:portrait",
      frameRate: 30,
      hasAudio: true,
      height: 1920,
      id: "portrait",
      name: "test_3.mp4",
      source: {
        kind: "test-asset" as const,
        name: "test_3.mp4",
        size: 1024,
      },
      width: 1080,
    };

    const first = applyProjectCommand(empty, {
      adaptCanvasToAsset: true,
      asset: portrait,
      type: "asset.add",
    });
    expect(first.canvas).toMatchObject({ height: 1920, width: 1080 });

    const second = applyProjectCommand(first, {
      adaptCanvasToAsset: true,
      asset: { ...portrait, id: "landscape", width: 1920, height: 1080 },
      type: "asset.add",
    });
    expect(second.canvas).toMatchObject({ height: 1920, width: 1080 });
  });

  it.each<{
    command: ProjectCommand;
    verify: (project: ReturnType<typeof createTestProject>) => void;
  }>([
    {
      command: {
        type: "asset.add",
        asset: {
          id: "asset-2",
          name: "imported.mp4",
          fingerprint: "sha256:imported",
          durationUs: 2_000_000,
          width: 1280,
          height: 720,
          frameRate: 30,
          hasAudio: false,
          source: {
            kind: "file",
            name: "imported.mp4",
            size: 2048,
          },
        },
      },
      verify: (project) =>
        expect(project.assets.map((asset) => asset.id)).toEqual([
          "asset-1",
          "asset-2",
        ]),
    },
    {
      command: {
        type: "clip.add",
        clip: {
          id: "clip-3",
          assetId: "asset-1",
          trackId: "video-1",
          timelineStartUs: 12_000_000,
          sourceStartUs: 0,
          sourceEndUs: 1_000_000,
          effects: [],
        },
      },
      verify: (project) =>
        expect(project.clips.map((clip) => clip.id)).toEqual([
          "clip-1",
          "clip-2",
          "clip-3",
        ]),
    },
    {
      command: {
        type: "clip.move",
        clipId: "clip-2",
        timelineStartUs: 7_000_000,
      },
      verify: (project) =>
        expect(project.clips[1]?.timelineStartUs).toBe(7_000_000),
    },
    {
      command: {
        type: "clip.trim",
        clipId: "clip-1",
        timelineStartUs: 1_000_000,
        sourceStartUs: 1_000_000,
        sourceEndUs: 4_000_000,
      },
      verify: (project) =>
        expect(project.clips[0]).toEqual(
          expect.objectContaining({
            timelineStartUs: 1_000_000,
            sourceStartUs: 1_000_000,
            sourceEndUs: 4_000_000,
          }),
        ),
    },
    {
      command: {
        type: "clip.transform",
        clipId: "clip-1",
        transform: {
          rotationDeg: 18,
          scale: 0.6,
          x: 0.68,
          y: 0.62,
        },
      },
      verify: (project) =>
        expect(project.clips[0]?.transform).toEqual({
          rotationDeg: 18,
          scale: 0.6,
          x: 0.68,
          y: 0.62,
        }),
    },
    {
      command: {
        type: "clip.split",
        clipId: "clip-1",
        rightClipId: "clip-right",
        timelineUs: 2_000_000,
      },
      verify: (project) => {
        expect(project.clips[0]?.sourceEndUs).toBe(2_000_000);
        expect(project.clips[1]).toEqual(
          expect.objectContaining({
            id: "clip-right",
            timelineStartUs: 2_000_000,
            sourceStartUs: 2_000_000,
            sourceEndUs: 5_000_000,
          }),
        );
      },
    },
    {
      command: { type: "clip.delete", clipId: "clip-1" },
      verify: (project) =>
        expect(project.clips.map((clip) => clip.id)).toEqual(["clip-2"]),
    },
    {
      command: {
        type: "text.add",
        text: {
          id: "title-2",
          trackId: "text-1",
          text: "新增标题",
          startUs: 5_000_000,
          endUs: 6_000_000,
          fontSize: 48,
          color: "#ffffff",
          x: 0.5,
          y: 0.5,
          scale: 1,
          rotationDeg: 0,
        },
      },
      verify: (project) =>
        expect(project.texts.map((text) => text.id)).toEqual([
          "title-1",
          "title-2",
        ]),
    },
    {
      command: { type: "text.delete", textId: "title-1" },
      verify: (project) => expect(project.texts).toEqual([]),
    },
    {
      command: {
        type: "text.update",
        textId: "title-1",
        patch: { text: "新标题", rotationDeg: 15 },
      },
      verify: (project) =>
        expect(project.texts[0]).toEqual(
          expect.objectContaining({ text: "新标题", rotationDeg: 15 }),
        ),
    },
    {
      command: {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: {
          id: "effect-1",
          kind: "grayscale",
          enabled: true,
          amount: 0.75,
        },
      },
      verify: (project) =>
        expect(project.clips[0]?.effects).toEqual([
          {
            id: "effect-1",
            kind: "grayscale",
            enabled: true,
            amount: 0.75,
          },
        ]),
    },
  ])("applies $command.type without mutating input", ({ command, verify }) => {
    const original = createTestProject();
    const snapshot = structuredClone(original);

    const result = applyProjectCommand(original, command, now);

    verify(result);
    expect(result.revision).toBe(1);
    expect(result.updatedAt).toBe(now);
    expect(original).toEqual(snapshot);
  });

  it("removes an effect through effect.set", () => {
    const withEffect = applyProjectCommand(
      createTestProject(),
      {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: {
          id: "effect-1",
          kind: "vintage",
          enabled: true,
          amount: 1,
        },
      },
      now,
    );

    const result = applyProjectCommand(
      withEffect,
      {
        type: "effect.set",
        clipId: "clip-1",
        effectId: "effect-1",
        effect: null,
      },
      now,
    );

    expect(result.clips[0]?.effects).toEqual([]);
  });

  it("checks invariants before committing a command", () => {
    expect(() =>
      applyProjectCommand(
        createTestProject(),
        {
          type: "clip.move",
          clipId: "clip-2",
          timelineStartUs: 4_000_000,
        },
        now,
      ),
    ).toThrow("重叠");
  });
});

describe("CommandBus", () => {
  it.each<ProjectCommand>([
    {
      type: "asset.add",
      asset: {
        id: "asset-2",
        name: "imported.mp4",
        fingerprint: "sha256:imported",
        durationUs: 2_000_000,
        width: 1280,
        height: 720,
        frameRate: 30,
        hasAudio: false,
        source: {
          kind: "file",
          name: "imported.mp4",
          size: 2048,
        },
      },
    },
    {
      type: "clip.add",
      clip: {
        id: "clip-3",
        assetId: "asset-1",
        trackId: "video-1",
        timelineStartUs: 12_000_000,
        sourceStartUs: 0,
        sourceEndUs: 1_000_000,
        effects: [],
      },
    },
    {
      type: "clip.move",
      clipId: "clip-2",
      timelineStartUs: 7_000_000,
    },
    {
      type: "clip.trim",
      clipId: "clip-1",
      timelineStartUs: 1_000_000,
      sourceStartUs: 1_000_000,
      sourceEndUs: 4_000_000,
    },
    {
      type: "clip.transform",
      clipId: "clip-1",
      transform: {
        rotationDeg: 18,
        scale: 0.6,
        x: 0.68,
        y: 0.62,
      },
    },
    {
      type: "clip.split",
      clipId: "clip-1",
      rightClipId: "clip-right",
      timelineUs: 2_000_000,
    },
    { type: "clip.delete", clipId: "clip-1" },
    {
      type: "text.add",
      text: {
        id: "title-2",
        trackId: "text-1",
        text: "新增标题",
        startUs: 5_000_000,
        endUs: 6_000_000,
        fontSize: 48,
        color: "#ffffff",
        x: 0.5,
        y: 0.5,
        scale: 1,
        rotationDeg: 0,
      },
    },
    { type: "text.delete", textId: "title-1" },
    {
      type: "text.update",
      textId: "title-1",
      patch: { text: "Undo/Redo" },
    },
    {
      type: "effect.set",
      clipId: "clip-1",
      effectId: "effect-1",
      effect: {
        id: "effect-1",
        kind: "adjustments",
        enabled: true,
        brightness: 0.2,
        contrast: -0.1,
      },
    },
  ])("round-trips $type through undo and redo", (command) => {
    const initial = createTestProject();
    const bus = new CommandBus(initial, { now: () => now });

    const applied = bus.execute(command);

    expect(bus.undo()).toEqual(initial);
    expect(bus.redo()).toEqual(applied);
  });

  it("merges adjacent commands with the same transaction ID", () => {
    const bus = new CommandBus(createTestProject(), { now: () => now });

    bus.execute(
      { type: "clip.move", clipId: "clip-2", timelineStartUs: 7_000_000 },
      { transactionId: "drag-1" },
    );
    const final = bus.execute(
      { type: "clip.move", clipId: "clip-2", timelineStartUs: 8_000_000 },
      { transactionId: "drag-1" },
    );

    expect(final.revision).toBe(2);
    expect(bus.history()).toHaveLength(1);
    expect(bus.history()[0]?.commandTypes).toEqual(["clip.move", "clip.move"]);
    expect(bus.undo()).toEqual(createTestProject());
    expect(bus.redo()).toEqual(final);
  });

  it("records command transaction and revision metadata", () => {
    const events: CommandEvent[] = [];
    const bus = new CommandBus(createTestProject(), {
      now: () => now,
      onChange: (_project, event) => events.push(event),
    });

    bus.execute(
      { type: "clip.delete", clipId: "clip-1" },
      { transactionId: "delete-1" },
    );
    bus.undo();
    bus.redo();

    expect(events).toEqual([
      expect.objectContaining({
        action: "execute",
        transactionId: "delete-1",
        beforeRevision: 0,
        afterRevision: 1,
      }),
      expect.objectContaining({
        action: "undo",
        beforeRevision: 1,
        afterRevision: 0,
      }),
      expect.objectContaining({
        action: "redo",
        beforeRevision: 0,
        afterRevision: 1,
      }),
    ]);
  });

  it("clears redo history after a new command", () => {
    const bus = new CommandBus(createTestProject(), { now: () => now });
    bus.execute({ type: "clip.delete", clipId: "clip-1" });
    bus.undo();
    expect(bus.canRedo).toBe(true);

    bus.execute({
      type: "text.update",
      textId: "title-1",
      patch: { text: "另一条历史" },
    });

    expect(bus.canRedo).toBe(false);
  });

  it("does not commit or create history when a command violates invariants", () => {
    const initial = createTestProject();
    const bus = new CommandBus(initial, { now: () => now });

    expect(() =>
      bus.execute({
        type: "clip.split",
        clipId: "clip-1",
        rightClipId: "clip-right",
        timelineUs: 0,
      }),
    ).toThrow("分割时间必须位于片段内部");
    expect(bus.document).toEqual(initial);
    expect(bus.history()).toEqual([]);
    expect(bus.canUndo).toBe(false);
  });

  it("rejects duplicate entity IDs without mutating the source document", () => {
    const original = createTestProject();

    expect(() =>
      applyProjectCommand(
        original,
        {
          asset: { ...original.assets[0]! },
          type: "asset.add",
        },
        now,
      ),
    ).toThrow('素材 "asset-1" 已存在');
    expect(original).toEqual(createTestProject());
  });
});
