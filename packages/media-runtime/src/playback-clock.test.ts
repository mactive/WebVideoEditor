import { describe, expect, it } from "vitest";

import { MonotonicProjectClock } from "./playback-clock";

describe("MonotonicProjectClock", () => {
  it("uses the audio clock while preserving monotonic time per generation", () => {
    let audioTime = 10;
    const clock = new MonotonicProjectClock({
      crossOriginIsolated: false,
      performanceNow: () => 99_000,
    });

    const started = clock.start(2_000_000, 7, {
      nowSeconds: () => audioTime,
      source: "audio",
      startedAtSeconds: 10,
    });
    expect(started).toMatchObject({
      projectRevision: 7,
      source: "audio",
      state: "running",
      timeUs: 2_000_000,
    });

    audioTime = 10.75;
    expect(clock.currentTimeUs()).toBe(2_750_000);
    audioTime = 10.5;
    expect(clock.currentTimeUs()).toBe(2_750_000);
    expect(clock.transport.read()).toEqual({
      state: "running",
      timeUs: 2_750_000,
    });
  });

  it("falls back to performance time and resets the monotonic interval on seek", () => {
    let performanceMs = 1_000;
    const clock = new MonotonicProjectClock({
      crossOriginIsolated: false,
      performanceNow: () => performanceMs,
    });

    const first = clock.start(5_000_000, 1);
    performanceMs = 1_250;
    expect(clock.currentTimeUs()).toBe(5_250_000);
    const paused = clock.pause();
    expect(paused.state).toBe("paused");

    const sought = clock.seek(1_000_000, 2);
    expect(sought.timeUs).toBe(1_000_000);
    expect(sought.generation).toBeGreaterThan(first.generation);
    performanceMs = 2_000;
    clock.start(1_000_000, 2);
    performanceMs = 2_400;
    expect(clock.currentTimeUs()).toBe(1_400_000);
  });
});
