import { describe, expect, it } from "vitest";

import { MemoryProxyCache, createProxyCacheKey } from "./proxy-cache";
import {
  DEFAULT_PROXY_PARAMETERS,
  LONG_VIDEO_PROXY_DURATION_SEC,
  LONG_VIDEO_PROXY_PARAMETER_OVERRIDES,
  MEDIA_PROXY_RESULT_VERSION,
  calculateProxyDimensions,
  resolveProxyParameters,
  type ProxyManifest,
} from "./proxy-types";

function manifest(cacheKey: string): ProxyManifest {
  return {
    cacheKey,
    cover: {
      byteLength: 3,
      height: 90,
      mimeType: "image/webp",
      path: "cover.webp",
      timestampSec: 0,
      width: 160,
    },
    createdAt: new Date(0).toISOString(),
    fingerprint: "sha256:test",
    keyframes: [
      {
        byteLength: 10,
        durationSec: 1 / 30,
        sequenceNumber: 0,
        timestampSec: 0,
      },
    ],
    parameters: DEFAULT_PROXY_PARAMETERS,
    proxy: {
      byteLength: 4,
      durationSec: 1,
      frameRate: 30,
      height: 540,
      mimeType: "video/mp4",
      path: "proxy.mp4",
      width: 960,
    },
    source: {
      durationSec: 1,
      height: 1080,
      width: 1920,
    },
    thumbnails: [],
    version: MEDIA_PROXY_RESULT_VERSION,
    waveform: {
      bucketCount: 1,
      byteLength: 12,
      maxValue: 0.5,
      mimeType: "application/x-float32",
      minValue: -0.5,
      path: "waveform.f32",
      rmsMax: 0.5,
      sampleCount: 2,
    },
  };
}

describe("proxy dimensions and cache keys", () => {
  it("preserves aspect ratio within even 960x540 bounds", () => {
    expect(
      calculateProxyDimensions(1920, 1080, DEFAULT_PROXY_PARAMETERS),
    ).toEqual({ height: 540, width: 960 });
    expect(
      calculateProxyDimensions(1080, 1920, DEFAULT_PROXY_PARAMETERS),
    ).toEqual({ height: 540, width: 302 });
    expect(
      calculateProxyDimensions(720, 720, DEFAULT_PROXY_PARAMETERS),
    ).toEqual({ height: 540, width: 540 });
    expect(
      calculateProxyDimensions(320, 181, DEFAULT_PROXY_PARAMETERS),
    ).toEqual({ height: 180, width: 320 });
  });

  it("invalidates the key when any generation parameter changes", async () => {
    const defaults = resolveProxyParameters();
    const changed = resolveProxyParameters({ waveformBuckets: 256 });
    await expect(createProxyCacheKey("sha256:a", defaults)).resolves.not.toBe(
      await createProxyCacheKey("sha256:a", changed),
    );
    await expect(createProxyCacheKey("sha256:b", defaults)).resolves.not.toBe(
      await createProxyCacheKey("sha256:a", defaults),
    );
  });

  it("uses lightweight defaults for long videos while preserving explicit overrides", () => {
    expect(
      resolveProxyParameters({}, LONG_VIDEO_PROXY_DURATION_SEC),
    ).toMatchObject(LONG_VIDEO_PROXY_PARAMETER_OVERRIDES);
    expect(
      resolveProxyParameters(
        { frameRate: 24, maxThumbnailCount: 120 },
        LONG_VIDEO_PROXY_DURATION_SEC,
      ),
    ).toMatchObject({
      frameRate: 24,
      maxThumbnailCount: 120,
      thumbnailIntervalSec:
        LONG_VIDEO_PROXY_PARAMETER_OVERRIDES.thumbnailIntervalSec,
    });
  });
});

describe("MemoryProxyCache test adapter", () => {
  it("atomically commits complete entries and reports capacity", async () => {
    const cache = new MemoryProxyCache();
    const transaction = await cache.begin("proxy-test");
    await transaction.write("proxy.mp4", new Uint8Array([1, 2, 3, 4]));
    await transaction.write("cover.webp", new Uint8Array([5, 6, 7]));
    await transaction.write("waveform.f32", new Float32Array([-0.5, 0.5, 0.5]));

    expect((await cache.stats()).entries).toBe(0);
    expect((await cache.stats()).temporaryEntries).toBe(1);

    await transaction.commit(manifest("proxy-test"));

    await expect(cache.get("proxy-test")).resolves.toMatchObject({
      cacheKey: "proxy-test",
      proxy: { byteLength: 4 },
    });
    expect(new Uint8Array(await cache.read("proxy-test", "proxy.mp4"))).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(await cache.stats()).toMatchObject({
      adapter: "memory",
      entries: 1,
      storageEstimate: { available: false },
      temporaryEntries: 0,
    });
  });

  it("removes aborted temporary entries and invalid manifests", async () => {
    const cache = new MemoryProxyCache();
    const aborted = await cache.begin("proxy-aborted");
    await aborted.write("proxy.mp4", new Uint8Array(1024));
    await aborted.abort();

    expect(await cache.stats()).toMatchObject({
      committedBytes: 0,
      entries: 0,
      temporaryBytes: 0,
      temporaryEntries: 0,
    });

    const invalid = await cache.begin("proxy-invalid");
    await invalid.write("proxy.mp4", new Uint8Array([1]));
    await invalid.commit(manifest("proxy-invalid"));
    await expect(cache.get("proxy-invalid")).resolves.toBeNull();
    expect((await cache.stats()).entries).toBe(0);
  });

  it("cleans oldest entries until the requested capacity is reached", async () => {
    const cache = new MemoryProxyCache();
    for (const key of ["proxy-1", "proxy-2"]) {
      const transaction = await cache.begin(key);
      await transaction.write("proxy.mp4", new Uint8Array(20));
      await transaction.write("cover.webp", new Uint8Array(3));
      await transaction.write("waveform.f32", new Uint8Array(12));
      await transaction.commit(manifest(key));
    }

    const before = await cache.stats();
    const after = await cache.cleanup(Math.floor(before.committedBytes / 2));

    expect(after.entries).toBeLessThan(before.entries);
    expect(after.committedBytes).toBeLessThanOrEqual(
      Math.floor(before.committedBytes / 2),
    );
  });

  it("rejects writes after commit and returns isolated read buffers", async () => {
    const cache = new MemoryProxyCache();
    const transaction = await cache.begin("proxy-isolated");
    await transaction.write("proxy.mp4", new Uint8Array([1, 2, 3, 4]));
    await transaction.write("cover.webp", new Uint8Array([5, 6, 7]));
    await transaction.write("waveform.f32", new Uint8Array(12));
    await transaction.commit(manifest("proxy-isolated"));

    await expect(
      transaction.commit(manifest("proxy-isolated")),
    ).rejects.toThrow("already settled");
    await expect(
      transaction.write("proxy.mp4", new Uint8Array([9])),
    ).rejects.toThrow("already settled");
    const first = new Uint8Array(
      await cache.read("proxy-isolated", "proxy.mp4"),
    );
    first[0] = 99;
    expect(
      new Uint8Array(await cache.read("proxy-isolated", "proxy.mp4")),
    ).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
