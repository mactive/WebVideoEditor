import { describe, expect, it } from "vitest";

import { sampleJsHeapMetrics, sampleStorageEstimate } from "./runtime-metrics";

describe("runtime performance metrics", () => {
  it("reports explicit heap availability and ignores invalid optional values", () => {
    const source = {
      memory: {
        jsHeapSizeLimit: Number.NaN,
        totalJSHeapSize: 2_000,
        usedJSHeapSize: 1_000,
      },
    } as unknown as Performance;

    expect(sampleJsHeapMetrics(source)).toEqual({
      available: true,
      totalJSHeapSize: 2_000,
      usedJSHeapSize: 1_000,
    });
    expect(sampleJsHeapMetrics({} as Performance)).toEqual({
      available: false,
    });
  });

  it("reports storage estimates without failing when the API is unavailable", async () => {
    await expect(
      sampleStorageEstimate({
        estimate: async () => ({ quota: 10_000, usage: 4_000 }),
      }),
    ).resolves.toEqual({
      available: true,
      quotaBytes: 10_000,
      usageBytes: 4_000,
    });
    await expect(sampleStorageEstimate(undefined)).resolves.toEqual({
      available: false,
    });
    await expect(
      sampleStorageEstimate({
        estimate: async () => {
          throw new DOMException("denied", "SecurityError");
        },
      }),
    ).resolves.toEqual({ available: false });
  });
});
