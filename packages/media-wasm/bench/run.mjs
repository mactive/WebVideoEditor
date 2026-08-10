import console from "node:console";
import { performance } from "node:perf_hooks";

import bindings from "../pkg-node/media_wasm.js";

const iterations = 100;
const pcm = Float32Array.from({ length: 48_000 }, (_, index) =>
  Math.sin(index * 0.01),
);
const bytes = new Uint8Array(1024 * 1024).fill(0x5a);
let sink;

function measure(name, operation) {
  const started = performance.now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    sink = operation();
  }
  const durationMs = performance.now() - started;
  console.info(
    `[WASM BENCH] ${name} iterations=${iterations} duration_ms=${durationMs.toFixed(3)}`,
  );
}

measure("timeline", () =>
  bindings.frame_to_microseconds(107_892, 30_000, 1_001),
);

measure(`waveform samples=${pcm.length} buckets=1000`, () => {
  const accumulator = new bindings.PcmWaveformAccumulator(pcm.length, 1_000);
  accumulator.push(pcm);
  const output = accumulator.finish();
  accumulator.free();
  return output[0];
});

measure(
  `summary bytes=${bytes.length}`,
  () => bindings.summarize_bytes(bytes)[1],
);

if (sink === undefined) {
  throw new Error("Benchmark operations did not produce output");
}
