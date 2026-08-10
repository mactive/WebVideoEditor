import { describe, expect, it, vi } from "vitest";

import {
  ResourceLifecycleTracker,
  SharedPlaybackClock,
  createAudioRingBuffer,
  createPlaybackClock,
} from "./index";

describe("SharedArrayBuffer media primitives", () => {
  it("shares a monotonic playback clock through Atomics", () => {
    const clock = createPlaybackClock({
      crossOriginIsolated: true,
      sharedArrayBuffer: SharedArrayBuffer,
    });

    expect(clock.mode).toBe("shared");
    clock.write({ state: "running", timeUs: 9_000_000_000_123 });
    expect(clock.read()).toEqual({
      state: "running",
      timeUs: 9_000_000_000_123,
    });
    clock.write({ state: "paused", timeUs: 44 });
    expect(clock.read()).toEqual({ state: "paused", timeUs: 44 });

    if (clock.mode !== "shared" || !clock.buffer) {
      throw new Error("Expected shared playback clocks");
    }
    const attached = new SharedPlaybackClock(clock.buffer);
    expect(attached.read()).toEqual({ state: "paused", timeUs: 44 });
  });

  it("falls back to explicit message clocks without isolation", () => {
    const publish = vi.fn();
    const clock = createPlaybackClock({
      crossOriginIsolated: false,
      publishFallback: publish,
      sharedArrayBuffer: SharedArrayBuffer,
    });

    expect(clock.mode).toBe("message");
    expect(clock.degradedReason).toContain("cross-origin isolation");
    clock.write({ state: "running", timeUs: 120 });
    expect(clock.read()).toEqual({ state: "running", timeUs: 120 });
    expect(publish).toHaveBeenCalledWith({
      state: "running",
      timeUs: 120,
    });
  });

  it.each([
    { isolated: true, mode: "shared" },
    { isolated: false, mode: "message" },
  ] as const)(
    "applies ring-buffer backpressure and wraparound in $mode mode",
    ({ isolated, mode }) => {
      const ring = createAudioRingBuffer(8, 2, {
        crossOriginIsolated: isolated,
        sharedArrayBuffer: SharedArrayBuffer,
      });

      expect(ring.mode).toBe(mode);
      expect(
        ring.write(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])),
      ).toBe(8);
      expect(ring.availableWrite).toBe(0);
      expect(ring.write(new Float32Array([11, 12]))).toBe(0);

      const first = new Float32Array(4);
      expect(ring.read(first)).toBe(4);
      expect(Array.from(first)).toEqual([1, 2, 3, 4]);
      expect(ring.write(new Float32Array([9, 10, 11, 12]))).toBe(4);

      const rest = new Float32Array(8);
      expect(ring.read(rest)).toBe(8);
      expect(Array.from(rest)).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
      expect(ring.availableRead).toBe(0);
    },
  );

  it("publishes copied audio messages in fallback mode", () => {
    const publish = vi.fn();
    const ring = createAudioRingBuffer(4, 1, {
      crossOriginIsolated: false,
      publishFallback: publish,
      sharedArrayBuffer: SharedArrayBuffer,
    });
    const source = new Float32Array([1, 2, 3]);

    expect(ring.write(source)).toBe(3);
    source[0] = 99;
    ring.clear();

    expect(publish).toHaveBeenNthCalledWith(1, {
      samples: new Float32Array([1, 2, 3]),
      type: "write",
    });
    expect(publish).toHaveBeenNthCalledWith(2, { type: "clear" });
  });
});

describe("media resource lifecycle counters", () => {
  it("closes frames, audio, codecs, Blob URLs and Workers exactly once", () => {
    const tracker = new ResourceLifecycleTracker();
    const close = vi.fn();
    const terminate = vi.fn();
    const revoke = vi.fn();
    const leases = [
      tracker.trackClosable("video-frame", { close }),
      tracker.trackClosable("audio-data", { close }),
      tracker.trackClosable("video-decoder", { close }),
      tracker.trackClosable("audio-decoder", { close }),
      tracker.trackClosable("video-encoder", { close }),
      tracker.trackClosable("audio-encoder", { close }),
      tracker.trackBlobUrl("blob:preview", revoke),
      tracker.trackWorker({ terminate }),
    ];

    expect(tracker.snapshot()).toMatchObject({
      activeTotal: 8,
      byType: {
        "audio-data": { active: 1, created: 1, peak: 1, released: 0 },
        "video-frame": { active: 1, created: 1, peak: 1, released: 0 },
      },
    });
    leases.forEach((lease) => {
      lease.release();
      lease.release();
    });

    expect(close).toHaveBeenCalledTimes(6);
    expect(terminate).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith("blob:preview");
    expect(tracker.snapshot().activeTotal).toBe(0);
    expect(tracker.snapshot().byType["video-frame"]).toEqual({
      active: 0,
      created: 1,
      peak: 1,
      released: 1,
    });
    expect(() => tracker.assertReleased()).not.toThrow();
  });

  it("updates counters even when resource cleanup throws", () => {
    const tracker = new ResourceLifecycleTracker();
    const lease = tracker.trackClosable("video-frame", {
      close: () => {
        throw new Error("close failed");
      },
    });

    expect(() => lease.release()).toThrow("close failed");
    expect(tracker.snapshot().activeTotal).toBe(0);
    expect(() => tracker.assertReleased()).not.toThrow();
  });

  it("returns frame counts to baseline after repeated consumption", () => {
    const tracker = new ResourceLifecycleTracker();
    const close = vi.fn();

    for (let index = 0; index < 1_000; index += 1) {
      tracker.trackClosable("video-frame", { close }).release();
    }

    expect(close).toHaveBeenCalledTimes(1_000);
    expect(tracker.snapshot().byType["video-frame"]).toEqual({
      active: 0,
      created: 1_000,
      peak: 1,
      released: 1_000,
    });
    expect(() => tracker.assertReleased()).not.toThrow();
  });

  it("releases every resource before reporting aggregate cleanup errors", () => {
    const tracker = new ResourceLifecycleTracker();
    const close = vi.fn();
    tracker.track("video-frame", () => {
      throw new Error("frame close failed");
    });
    tracker.track("audio-data", close);
    tracker.track("video-decoder", () => {
      throw new Error("decoder close failed");
    });

    expect(() => tracker.releaseAll()).toThrow(AggregateError);
    expect(close).toHaveBeenCalledOnce();
    expect(tracker.snapshot().activeTotal).toBe(0);
  });
});
