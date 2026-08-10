import {
  LogHub,
  StructuredLogger,
  validateLogEntry,
} from "@web-video-editor/observability";
import { describe, expect, it } from "vitest";

import { initMediaWasm, type WasmModuleLoader } from "./index";

const nodeModuleUrl = "../pkg-node/media_wasm.js";

const loadNodeBindings: WasmModuleLoader = async () => {
  const loaded = (await import(/* @vite-ignore */ nodeModuleUrl)) as Record<
    string,
    unknown
  >;
  return (
    "seconds_to_microseconds" in loaded ? loaded : loaded.default
  ) as Awaited<ReturnType<WasmModuleLoader>>;
};

function captureLogs() {
  const hub = new LogHub();
  return {
    events: hub.getEntries.bind(hub),
    logger: new StructuredLogger(hub, "media-wasm-test"),
  };
}

describe("media WASM TypeScript wrapper", () => {
  it("loads the generated module and converts timeline units", async () => {
    const sdk = await initMediaWasm({
      loader: loadNodeBindings,
      logger: captureLogs().logger,
    });

    expect(sdk.secondsToMicroseconds(1.234567)).toBe(1_234_567);
    expect(sdk.microsecondsToSeconds(1_234_567)).toBeCloseTo(1.234567);
    expect(sdk.frameToMicroseconds(30, 30_000, 1_001)).toBe(1_001_000);
    expect(sdk.microsecondsToFrame(1_001_000, 30_000, 1_001)).toBe(30);
  });

  it("keeps incremental PCM state and exposes zero-copy result views", async () => {
    const sdk = await initMediaWasm({
      loader: loadNodeBindings,
      logger: captureLogs().logger,
    });
    const waveform = sdk.createWaveform(8, 2);

    waveform.push(new Float32Array([-1, -0.5, 0.5]));
    waveform.push(new Float32Array([1, -0.25, 0.25, -0.75, 0.75]));
    const result = waveform.finish();

    expect(Array.from(result.min)).toEqual([-1, -0.75]);
    expect(Array.from(result.max)).toEqual([1, 0.75]);
    expect(result.rms[0]).toBeCloseTo(Math.sqrt(0.625));
    expect(result.rms[1]).toBeCloseTo(Math.sqrt(0.3125));
    expect(result.min.buffer).toBe(result.data.buffer);
    expect(result.max.buffer).toBe(result.data.buffer);
    expect(result.rms.buffer).toBe(result.data.buffer);
    waveform.dispose();
  });

  it("summarizes Uint8Array and ArrayBuffer inputs", async () => {
    const sdk = await initMediaWasm({
      loader: loadNodeBindings,
      logger: captureLogs().logger,
    });

    expect(sdk.summarizeBytes(new Uint8Array([1, 2, 3]))).toMatchObject({
      byteLength: 3,
      checksum32: 1_456_420_779,
      min: 1,
      max: 3,
      xor: 0,
    });
    expect(sdk.summarizeBytes(new Uint8Array().buffer)).toMatchObject({
      byteLength: 0,
      checksum32: 2_166_136_261,
      min: 0,
      max: 0,
      xor: 0,
    });
  });

  it("emits injectable structured performance and error logs", async () => {
    const logs = captureLogs();
    const sdk = await initMediaWasm({
      loader: loadNodeBindings,
      logger: logs.logger,
      requestId: "wasm_01",
    });

    expect(() => sdk.frameToMicroseconds(1, 0)).toThrow();
    const events = logs.events();
    expect(events.every((event) => event.marker === "[WASM]")).toBe(true);
    expect(events.every((event) => event.requestId === "wasm_01")).toBe(true);
    expect(events.every((event) => validateLogEntry(event).length === 0)).toBe(
      true,
    );
    expect(events.map((event) => event.event)).toContain("call.completed");
    expect(events.map((event) => event.event)).toContain("call.failed");
    expect(events.at(-1)?.input).toEqual(
      expect.objectContaining({
        operation: "timeline.frame-to-microseconds",
      }),
    );
    expect(events.at(-1)?.error?.message).toContain("non-zero");
  });

  it("rejects unsafe timeline values and invalid PCM without partial progress", async () => {
    const logs = captureLogs();
    const sdk = await initMediaWasm({
      loader: loadNodeBindings,
      logger: logs.logger,
    });
    const waveform = sdk.createWaveform(2, 1);

    expect(() => sdk.secondsToMicroseconds(Number.POSITIVE_INFINITY)).toThrow(
      "finite",
    );
    expect(() => waveform.push(new Float32Array([0.5, Number.NaN]))).toThrow(
      "finite samples",
    );
    expect(() => waveform.finish()).toThrow("received 0");
    const failures = logs
      .events()
      .filter((event) => event.event === "call.failed");
    expect(failures).toHaveLength(3);
    expect(failures.map((event) => event.input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "timeline.seconds-to-microseconds",
        }),
        expect.objectContaining({ operation: "waveform.chunk" }),
        expect.objectContaining({ operation: "waveform.finish" }),
      ]),
    );
    waveform.dispose();
  });

  it("wraps initialization failures with a stable error", async () => {
    const logs = captureLogs();
    const cause = new Error("module missing");

    await expect(
      initMediaWasm({
        loader: () => Promise.reject(cause),
        logger: logs.logger,
      }),
    ).rejects.toMatchObject({
      message: "Failed to initialize media WASM SDK",
      cause,
    });
    expect(logs.events().at(-1)).toMatchObject({
      marker: "[WASM]",
      event: "call.failed",
      input: { operation: "init" },
      error: { message: "module missing" },
    });
  });
});
