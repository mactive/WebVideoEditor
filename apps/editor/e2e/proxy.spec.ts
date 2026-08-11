import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const probeModuleUrl = `/@fs${resolve(
  process.cwd(),
  "packages/media-runtime/src/probe.ts",
)}`;

test.describe.configure({ mode: "serial" });

test("generates, caches, reprobes, and plays the real test_1 proxy", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await page.getByRole("button", { name: "清理代理缓存" }).click();
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();

  const firstItem = page.locator(".media-panel__results > li").first();
  await expect(firstItem).toContainText("test_1.mp4");
  await expect(firstItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 4 * 60_000 },
  );

  const verification = await page.evaluate(async (moduleUrl) => {
    const storageRoot = await navigator.storage.getDirectory();
    const cacheRoot = await storageRoot.getDirectoryHandle(
      "web-video-editor-media-cache-v1",
    );
    const entries = cacheRoot as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      >;
    };
    let entry: FileSystemDirectoryHandle | undefined;
    for await (const [name, handle] of entries.entries()) {
      if (!name.startsWith(".tmp-") && handle.kind === "directory") {
        entry = handle;
        break;
      }
    }
    if (!entry) {
      throw new Error("Committed OPFS proxy entry was not found");
    }
    const manifest = JSON.parse(
      await (
        await entry.getFileHandle("manifest.json")
      )
        .getFile()
        .then((file) => file.text()),
    ) as {
      keyframes: unknown[];
      proxy: {
        byteLength: number;
        durationSec: number;
        height: number;
        path: string;
        width: number;
      };
      thumbnails: Array<{ path: string }>;
      waveform: {
        bucketCount: number;
        path: string;
        sampleCount: number;
      };
    };
    const proxyFile = await entry
      .getFileHandle(manifest.proxy.path)
      .then((handle) => handle.getFile());
    const probeModule = (await import(
      moduleUrl
    )) as typeof import("../../../packages/media-runtime/src/probe");
    const probe = await probeModule.probeBrowserMedia({
      blob: proxyFile,
      kind: "blob",
      name: "test_1.proxy.mp4",
    });

    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(proxyFile);
    await new Promise<void>((resolveLoaded, reject) => {
      video.addEventListener("loadedmetadata", () => resolveLoaded(), {
        once: true,
      });
      video.addEventListener(
        "error",
        () => reject(video.error ?? new Error("Proxy video failed to load")),
        { once: true },
      );
    });
    await video.play();
    await new Promise((resolvePlayback) => setTimeout(resolvePlayback, 350));
    const playbackTime = video.currentTime;
    video.pause();
    URL.revokeObjectURL(video.src);

    const thumbnailFile = await entry
      .getFileHandle(manifest.thumbnails[0]!.path)
      .then((handle) => handle.getFile());
    const thumbnail = await createImageBitmap(thumbnailFile);
    const thumbnailSize = {
      height: thumbnail.height,
      width: thumbnail.width,
    };
    thumbnail.close();

    const waveformFile = await entry
      .getFileHandle(manifest.waveform.path)
      .then((handle) => handle.getFile());
    const waveform = new Float32Array(await waveformFile.arrayBuffer());
    let temporaryEntries = 0;
    for await (const [name] of entries.entries()) {
      if (name.startsWith(".tmp-")) {
        temporaryEntries += 1;
      }
    }
    return {
      keyframes: manifest.keyframes.length,
      manifest,
      playbackTime,
      probe,
      temporaryEntries,
      thumbnailSize,
      waveformFinite: waveform.every(Number.isFinite),
      waveformMax: Math.max(...waveform),
      waveformMin: Math.min(...waveform),
      waveformValues: waveform.length,
    };
  }, probeModuleUrl);

  const proxyVideo = verification.probe.videoTracks.find(
    (track) => track.trackId === verification.probe.primaryVideoTrackId,
  );
  expect(proxyVideo).toMatchObject({
    codec: "avc",
    displayHeight: 540,
    displayWidth: 540,
  });
  expect(Math.abs(verification.probe.durationSec - 36.053333)).toBeLessThan(
    0.15,
  );
  expect(verification.probe.primaryAudioTrackId).not.toBeNull();
  expect(verification.manifest.proxy.byteLength).toBeGreaterThan(100_000);
  expect(verification.keyframes).toBeGreaterThan(1);
  expect(verification.thumbnailSize).toEqual({ height: 160, width: 160 });
  expect(verification.waveformValues).toBe(
    verification.manifest.waveform.bucketCount * 3,
  );
  expect(verification.manifest.waveform.sampleCount).toBe(1_730_560);
  expect(verification.waveformFinite).toBe(true);
  expect(verification.waveformMin).toBeGreaterThanOrEqual(-1);
  expect(verification.waveformMax).toBeLessThanOrEqual(1);
  expect(verification.waveformMax).toBeGreaterThan(0);
  expect(verification.playbackTime).toBeGreaterThan(0);
  expect(verification.temporaryEntries).toBe(0);

  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const cachedItem = page.locator(".media-panel__results > li").first();
  await expect(cachedItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 30_000 },
  );
  await expect(cachedItem.locator(".proxy-progress")).toContainText("HIT");
});

test("generates and caches test_3 proxy despite a small PCM sample count mismatch", async ({
  page,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  await page.goto("/");
  await page.getByRole("button", { name: "清理代理缓存" }).click();
  await page.getByRole("button", { name: /test_3\.mp4/ }).click();

  const firstItem = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_3.mp4" })
    .first();
  await expect(firstItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 7 * 60_000 },
  );
  await expect(firstItem.locator(".proxy-progress")).toContainText("PCM");

  const verification = await page.evaluate(async () => {
    const storageRoot = await navigator.storage.getDirectory();
    const cacheRoot = await storageRoot.getDirectoryHandle(
      "web-video-editor-media-cache-v1",
    );
    const entries = cacheRoot as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<
        [string, FileSystemDirectoryHandle | FileSystemFileHandle]
      >;
    };
    let committed:
      | {
          directory: FileSystemDirectoryHandle;
          manifest: {
            diagnostics?: {
              pcmSampleCount?: {
                delta: number;
                expected: number;
                received: number;
                strategy: string;
                tolerance: number;
              };
            };
            proxy: {
              byteLength: number;
              height: number;
              path: string;
              width: number;
            };
            waveform: {
              bucketCount: number;
              path: string;
              sampleCount: number;
            };
          };
        }
      | undefined;
    let temporaryEntries = 0;
    for await (const [name, handle] of entries.entries()) {
      if (name.startsWith(".tmp-")) {
        temporaryEntries += 1;
        continue;
      }
      if (handle.kind !== "directory") {
        continue;
      }
      const directory = handle as FileSystemDirectoryHandle;
      const manifest = JSON.parse(
        await directory
          .getFileHandle("manifest.json")
          .then((file) => file.getFile())
          .then((file) => file.text()),
      ) as NonNullable<typeof committed>["manifest"];
      if (manifest.diagnostics?.pcmSampleCount) {
        committed = { directory, manifest };
      }
    }
    if (!committed) {
      throw new Error("Committed test_3 proxy diagnostics were not found");
    }
    const proxyFile = await committed.directory
      .getFileHandle(committed.manifest.proxy.path)
      .then((handle) => handle.getFile());
    const waveformFile = await committed.directory
      .getFileHandle(committed.manifest.waveform.path)
      .then((handle) => handle.getFile());
    const waveform = new Float32Array(await waveformFile.arrayBuffer());
    return {
      manifest: committed.manifest,
      proxyBytes: proxyFile.size,
      temporaryEntries,
      waveformFinite: waveform.every(Number.isFinite),
      waveformValues: waveform.length,
    };
  });
  await testInfo.attach("test3-proxy-evidence", {
    body: JSON.stringify(verification, null, 2),
    contentType: "application/json",
  });

  expect(verification.manifest.diagnostics?.pcmSampleCount).toEqual({
    delta: -368,
    expected: 6_001_008,
    received: 6_000_640,
    strategy: "pad-silence",
    tolerance: 4_800,
  });
  expect(verification.manifest.proxy).toMatchObject({
    height: 540,
    width: 302,
  });
  expect(verification.proxyBytes).toBeGreaterThan(100_000);
  expect(verification.waveformValues).toBe(
    verification.manifest.waveform.bucketCount * 3,
  );
  expect(verification.manifest.waveform.sampleCount).toBe(6_001_008);
  expect(verification.waveformFinite).toBe(true);
  expect(verification.temporaryEntries).toBe(0);

  await page.getByRole("button", { name: /test_3\.mp4/ }).click();
  const cachedItem = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_3.mp4" })
    .first();
  await expect(cachedItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 30_000 },
  );
  await expect(cachedItem.locator(".proxy-progress")).toContainText("HIT");
  await expect(cachedItem.locator(".proxy-progress")).toContainText("PCM");
});
