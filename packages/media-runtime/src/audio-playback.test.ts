import { describe, expect, it, vi } from "vitest";

import {
  MediabunnyAudioPlayback,
  type AudioWindowDecoder,
  type DecodedAudioBuffer,
} from "./audio-playback";

type FakeSource = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function audioHarness() {
  const nodes: FakeSource[] = [];
  const context = {
    close: vi.fn(async () => undefined),
    createBufferSource: vi.fn(() => {
      const node: FakeSource = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
      };
      nodes.push(node);
      return node;
    }),
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => undefined),
    state: "running",
  } as unknown as AudioContext;
  return { context, nodes };
}

function decoded(
  timestampSec: number,
  durationSec: number,
): DecodedAudioBuffer {
  return {
    buffer: { duration: durationSec } as AudioBuffer,
    durationSec,
    timestampSec,
  };
}

const sources = new Map([
  ["asset-a", { kind: "url", url: "/a.mp4" } as const],
  ["asset-b", { kind: "url", url: "/b.mp4" } as const],
]);

describe("MediabunnyAudioPlayback", () => {
  it("schedules only clip intersections and stops exactly at clip boundaries", async () => {
    const { context, nodes } = audioHarness();
    const decodeWindow: AudioWindowDecoder = vi.fn(
      async (_source, startSec, endSec) => [
        decoded(startSec, endSec - startSec),
      ],
    );
    const playback = new MediabunnyAudioPlayback({
      audioContext: context,
      decodeWindow,
      lookAheadUs: 2_000_000,
      scheduleLeadSec: 0,
      sources,
    });

    const started = await playback.start({
      clips: [
        {
          assetId: "asset-a",
          id: "clip-a",
          sourceEndUs: 2_000_000,
          sourceStartUs: 1_000_000,
          timelineStartUs: 0,
        },
        {
          assetId: "asset-b",
          id: "clip-b",
          sourceEndUs: 6_000_000,
          sourceStartUs: 5_000_000,
          timelineStartUs: 1_000_000,
        },
      ],
      projectDurationUs: 2_000_000,
      projectRevision: 3,
      startTimeUs: 0,
    });

    expect(started.hasAudio).toBe(true);
    expect(decodeWindow).toHaveBeenNthCalledWith(
      1,
      sources.get("asset-a"),
      1,
      2,
      expect.any(AbortSignal),
    );
    expect(decodeWindow).toHaveBeenNthCalledWith(
      2,
      sources.get("asset-b"),
      5,
      6,
      expect.any(AbortSignal),
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.start).toHaveBeenCalledWith(10, 0);
    expect(nodes[0]?.stop).toHaveBeenCalledWith(11);
    expect(nodes[1]?.start).toHaveBeenCalledWith(11, 0);
    expect(nodes[1]?.stop).toHaveBeenCalledWith(12);
  });

  it("mixes overlapping clips by scheduling each source at the same timeline time", async () => {
    const { context, nodes } = audioHarness();
    const decodeWindow: AudioWindowDecoder = vi.fn(
      async (_source, startSec, endSec) => [
        decoded(startSec - 0.25, endSec - startSec + 0.5),
      ],
    );
    const playback = new MediabunnyAudioPlayback({
      audioContext: context,
      decodeWindow,
      lookAheadUs: 2_000_000,
      scheduleLeadSec: 0,
      sources,
    });

    await playback.start({
      clips: [
        {
          assetId: "asset-a",
          id: "clip-a",
          sourceEndUs: 6_000_000,
          sourceStartUs: 5_000_000,
          timelineStartUs: 1_000_000,
        },
        {
          assetId: "asset-b",
          id: "clip-b",
          sourceEndUs: 11_000_000,
          sourceStartUs: 10_000_000,
          timelineStartUs: 1_500_000,
        },
      ],
      projectDurationUs: 3_500_000,
      projectRevision: 3,
      startTimeUs: 1_500_000,
    });

    expect(decodeWindow).toHaveBeenNthCalledWith(
      1,
      sources.get("asset-a"),
      5.5,
      6,
      expect.any(AbortSignal),
    );
    expect(decodeWindow).toHaveBeenNthCalledWith(
      2,
      sources.get("asset-b"),
      10,
      11,
      expect.any(AbortSignal),
    );
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.start).toHaveBeenCalledWith(10, 0.25);
    expect(nodes[0]?.stop).toHaveBeenCalledWith(10.5);
    expect(nodes[1]?.start).toHaveBeenCalledWith(10, 0.25);
    expect(nodes[1]?.stop).toHaveBeenCalledWith(11);
    expect(playback.stats().activeSources).toBe(2);
  });

  it("skips muted clips in the playback request", async () => {
    const { context, nodes } = audioHarness();
    const decodeWindow: AudioWindowDecoder = vi.fn(
      async (_source, startSec, endSec) => [
        decoded(startSec, endSec - startSec),
      ],
    );
    const playback = new MediabunnyAudioPlayback({
      audioContext: context,
      decodeWindow,
      lookAheadUs: 1_000_000,
      scheduleLeadSec: 0,
      sources,
    });

    await playback.start({
      clips: [
        {
          assetId: "asset-a",
          id: "clip-a",
          muted: true,
          sourceEndUs: 1_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
        },
        {
          assetId: "asset-b",
          id: "clip-b",
          sourceEndUs: 2_000_000,
          sourceStartUs: 1_000_000,
          timelineStartUs: 0,
        },
      ],
      projectDurationUs: 1_000_000,
      projectRevision: 3,
      startTimeUs: 0,
    });

    expect(decodeWindow).toHaveBeenCalledOnce();
    expect(decodeWindow).toHaveBeenCalledWith(
      sources.get("asset-b"),
      1,
      2,
      expect.any(AbortSignal),
    );
    expect(nodes).toHaveLength(1);
  });

  it("stops every old source before scheduling a new seek generation", async () => {
    const { context, nodes } = audioHarness();
    const playback = new MediabunnyAudioPlayback({
      audioContext: context,
      decodeWindow: async (_source, startSec, endSec) => [
        decoded(startSec, endSec - startSec),
      ],
      lookAheadUs: 1_000_000,
      scheduleLeadSec: 0,
      sources,
    });
    const request = {
      clips: [
        {
          assetId: "asset-a",
          id: "clip-a",
          sourceEndUs: 2_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
        },
      ],
      projectDurationUs: 1_000_000,
      projectRevision: 1,
      startTimeUs: 0,
    };

    const first = await playback.start(request);
    const oldNode = nodes[0]!;
    const second = await playback.start({
      ...request,
      projectRevision: 2,
      startTimeUs: 500_000,
    });

    expect(oldNode.stop).toHaveBeenCalledWith();
    expect(oldNode.disconnect).toHaveBeenCalledOnce();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(playback.stats()).toMatchObject({
      activeGenerations: [second.generation],
      activeSources: 1,
      projectRevision: 2,
      stoppedSources: 1,
    });
  });

  it("rejects decoded buffers that arrive from a superseded generation", async () => {
    const { context } = audioHarness();
    const resolvers: Array<(buffers: DecodedAudioBuffer[]) => void> = [];
    const decodeWindow: AudioWindowDecoder = () =>
      new Promise((resolve) => resolvers.push(resolve));
    const playback = new MediabunnyAudioPlayback({
      audioContext: context,
      decodeWindow,
      lookAheadUs: 1_000_000,
      scheduleLeadSec: 0,
      sources,
    });
    const request = {
      clips: [
        {
          assetId: "asset-a",
          id: "clip-a",
          sourceEndUs: 2_000_000,
          sourceStartUs: 0,
          timelineStartUs: 0,
        },
      ],
      projectDurationUs: 1_000_000,
      projectRevision: 1,
      startTimeUs: 0,
    };

    const first = playback.start(request);
    await Promise.resolve();
    const second = playback.start({ ...request, projectRevision: 2 });
    await Promise.resolve();
    resolvers[0]?.([decoded(0, 1)]);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    resolvers[1]?.([decoded(0, 1)]);
    await expect(second).resolves.toMatchObject({ hasAudio: true });
    expect(playback.stats().staleBuffers).toBe(1);
  });
});
