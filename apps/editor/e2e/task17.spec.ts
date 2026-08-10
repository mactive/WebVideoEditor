import type {
  BrowserMediaSource,
  MediaProbeResult,
  ResourceLifecycleSnapshot,
} from "@web-video-editor/media-runtime";
import type { PreviewRuntimeSnapshot } from "@web-video-editor/preview-runtime";
import type { LogEntry } from "@web-video-editor/observability";
import { expect, test, type Page } from "@playwright/test";

declare global {
  interface Window {
    __TASK_14_MEDIA__?: {
      probe(source: BrowserMediaSource): Promise<MediaProbeResult>;
    };
    __TASK_14_RUNTIME__?: {
      getLogs(): readonly LogEntry[];
    };
    __TASK_8_PREVIEW__?: {
      getResources(): ResourceLifecycleSnapshot;
      getSnapshot(): PreviewRuntimeSnapshot;
    };
  }
}

test.describe.configure({ mode: "serial" });

async function importAsset(page: Page, name: "test_1.mp4" | "test_3.mp4") {
  await page
    .getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })
    .click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: name })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  return item;
}

async function waitForProxy(item: ReturnType<Page["locator"]>) {
  const progress = item.locator(".proxy-progress");
  await expect(progress).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  return progress;
}

async function projectJson(page: Page) {
  await page.getByRole("button", { name: "Project JSON" }).click();
  return JSON.parse((await page.getByTestId("project-json").textContent())!);
}

async function inspectTestOneProxy(page: Page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const cacheRoot = await root.getDirectoryHandle(
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
            cacheKey: string;
            cover: { path: string };
            fingerprint: string;
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
      if (
        manifest.fingerprint ===
        "sha256:a88ca5a5411746d08343009687f2ca86d281a1aeb5532fe5b39fae3bfd855c12"
      ) {
        committed = { directory, manifest };
      }
    }
    if (!committed) {
      throw new Error("Committed test_1 proxy was not found");
    }

    const imageStats = async (path: string) => {
      const file = await committed!.directory
        .getFileHandle(path)
        .then((handle) => handle.getFile());
      const bitmap = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let coloredPixels = 0;
      let luminanceMin = 255;
      let luminanceMax = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        const luminance = (red + green + blue) / 3;
        luminanceMin = Math.min(luminanceMin, luminance);
        luminanceMax = Math.max(luminanceMax, luminance);
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 12) {
          coloredPixels += 1;
        }
      }
      return {
        coloredPixels,
        height: canvas.height,
        luminanceRange: luminanceMax - luminanceMin,
        width: canvas.width,
      };
    };

    const proxyFile = await committed.directory
      .getFileHandle(committed.manifest.proxy.path)
      .then((handle) => handle.getFile());
    const reprobe = await window.__TASK_14_MEDIA__!.probe({
      blob: proxyFile,
      kind: "blob",
      name: "test_1.proxy.mp4",
    });
    const video = document.createElement("video");
    video.muted = true;
    video.src = URL.createObjectURL(proxyFile);
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener(
        "error",
        () => reject(video.error ?? new Error("Proxy playback failed")),
        { once: true },
      );
    });
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const playbackTime = video.currentTime;
    video.pause();
    URL.revokeObjectURL(video.src);

    const waveformFile = await committed.directory
      .getFileHandle(committed.manifest.waveform.path)
      .then((handle) => handle.getFile());
    const waveform = new Float32Array(await waveformFile.arrayBuffer());
    const logs = window.__TASK_14_RUNTIME__!.getLogs();
    return {
      cacheKey: committed.manifest.cacheKey,
      codecSupport: await Promise.all(
        (
          [
            "no-preference",
            "prefer-hardware",
            "prefer-software",
          ] as VideoEncoderConfig["hardwareAcceleration"][]
        ).map(async (hardwareAcceleration) => ({
          hardwareAcceleration,
          supported: (
            await VideoEncoder.isConfigSupported({
              codec: "avc1.42001f",
              framerate: 30,
              hardwareAcceleration,
              height: 540,
              width: 540,
            })
          ).supported,
        })),
      ),
      cover: await imageStats(committed.manifest.cover.path),
      generationDurations: logs
        .filter(
          (entry) =>
            entry.marker === "[PROXY]" &&
            entry.event === "generation.completed" &&
            entry.scope === "media-worker" &&
            entry.durationMs !== undefined,
        )
        .map((entry) => entry.durationMs),
      hasCacheHit: logs.some(
        (entry) => entry.marker === "[PROXY]" && entry.event === "cache.hit",
      ),
      hasCacheMiss: logs.some(
        (entry) => entry.marker === "[PROXY]" && entry.event === "cache.miss",
      ),
      hasWasmWaveform: logs.some(
        (entry) =>
          entry.marker === "[WASM]" && entry.event === "waveform.completed",
      ),
      keyframes: committed.manifest.keyframes.length,
      manifest: committed.manifest,
      playbackTime,
      reprobe,
      temporaryEntries,
      thumbnail: await imageStats(committed.manifest.thumbnails[0]!.path),
      waveformFinite: waveform.every(Number.isFinite),
      waveformMax: Math.max(...waveform),
      waveformMin: Math.min(...waveform),
      waveformValues: waveform.length,
    };
  });
}

test("generates the complete test_1 proxy twice and exercises real preview transport", async ({
  page,
}, testInfo) => {
  test.setTimeout(4 * 60_000);
  await page.goto("/");
  const clearCache = page.getByRole("button", { name: "清理代理缓存" });
  await clearCache.click();

  const first = await importAsset(page, "test_1.mp4");
  await waitForProxy(first);
  const firstEvidence = await inspectTestOneProxy(page);

  const hit = await importAsset(page, "test_1.mp4");
  await expect(await waitForProxy(hit)).toContainText("HIT");

  await clearCache.click();
  const second = await importAsset(page, "test_1.mp4");
  await waitForProxy(second);
  const secondEvidence = await inspectTestOneProxy(page);
  await testInfo.attach("task17-proxy-evidence", {
    body: JSON.stringify({ firstEvidence, secondEvidence }, null, 2),
    contentType: "application/json",
  });

  const primaryVideo = secondEvidence.reprobe.videoTracks.find(
    (track) => track.trackId === secondEvidence.reprobe.primaryVideoTrackId,
  );
  expect(primaryVideo).toMatchObject({
    codec: "avc",
    displayHeight: 540,
    displayWidth: 540,
  });
  expect(secondEvidence.reprobe.primaryAudioTrackId).not.toBeNull();
  expect(Math.abs(secondEvidence.reprobe.durationSec - 36.053333)).toBeLessThan(
    0.15,
  );
  expect(secondEvidence.manifest.proxy.byteLength).toBeGreaterThan(100_000);
  expect(secondEvidence.keyframes).toBeGreaterThan(1);
  expect(secondEvidence.manifest.thumbnails.length).toBeGreaterThan(1);
  expect(secondEvidence.cover).toMatchObject({ height: 160, width: 160 });
  expect(secondEvidence.cover.coloredPixels).toBeGreaterThan(100);
  expect(secondEvidence.cover.luminanceRange).toBeGreaterThan(30);
  expect(secondEvidence.thumbnail.coloredPixels).toBeGreaterThan(100);
  expect(secondEvidence.waveformValues).toBe(
    secondEvidence.manifest.waveform.bucketCount * 3,
  );
  expect(secondEvidence.manifest.waveform.sampleCount).toBe(1_730_560);
  expect(secondEvidence.waveformFinite).toBe(true);
  expect(secondEvidence.waveformMin).toBeGreaterThanOrEqual(-1);
  expect(secondEvidence.waveformMax).toBeLessThanOrEqual(1);
  expect(secondEvidence.waveformMax).toBeGreaterThan(0);
  expect(secondEvidence.playbackTime).toBeGreaterThan(0);
  expect(secondEvidence.temporaryEntries).toBe(0);
  expect(secondEvidence.hasCacheMiss).toBe(true);
  expect(secondEvidence.hasCacheHit).toBe(true);
  expect(secondEvidence.hasWasmWaveform).toBe(true);
  expect(secondEvidence.generationDurations).toHaveLength(2);
  expect(
    secondEvidence.codecSupport.find(
      (entry) => entry.hardwareAcceleration === "no-preference",
    )?.supported,
  ).toBe(true);

  await second.getByRole("button", { name: /添加到时间线/ }).click();
  const panel = page.locator(".preview-panel");
  await expect(panel).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedFrames ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  const beforePlay = await page.evaluate(
    () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
  );
  const presentedBeforePlay = await page.evaluate(
    () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.presentedFrames,
  );
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
      ),
    )
    .toBeGreaterThan(beforePlay + 200_000);
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.presentedFrames,
      ),
    )
    .toBeGreaterThan(presentedBeforePlay + 2);
  await page.getByRole("button", { name: "暂停" }).click();

  const beforeStep = await page.evaluate(
    () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
  );
  await page.getByRole("button", { name: "下一帧" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
      ),
    )
    .toBeGreaterThan(beforeStep);
  await page.getByRole("button", { name: "上一帧" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
      ),
    )
    .toBeLessThanOrEqual(beforeStep + 1);

  const slider = page.getByRole("slider", { name: "预览播放头" });
  const sliderBox = await slider.boundingBox();
  expect(sliderBox).not.toBeNull();
  await page.mouse.click(
    sliderBox!.x + sliderBox!.width * 0.7,
    sliderBox!.y + sliderBox!.height / 2,
  );
  const durationUs = Number(await slider.getAttribute("max"));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__!.getSnapshot().metrics.presentedPlayheadUs,
      ),
    )
    .toBeGreaterThan(durationUs * 0.6);
  const clickedPlayhead = await page.evaluate(
    () => window.__TASK_8_PREVIEW__!.getSnapshot().metrics.playheadUs,
  );
  expect(clickedPlayhead).toBeLessThan(durationUs * 0.8);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__!.getResources().byType["video-frame"]
              .active,
        ),
      { timeout: 30_000 },
    )
    .toBe(0);
});

async function titlePixelEvidence(page: Page) {
  return page
    .locator("canvas[data-preview-canvas='pixi-v8']")
    .evaluate((canvas) => {
      const source = canvas as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const points: Array<{ x: number; y: number }> = [];
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          (pixels[index] ?? 0) > 170 &&
          (pixels[index + 1] ?? 255) < 120 &&
          (pixels[index + 2] ?? 0) > 170
        ) {
          const pixel = index / 4;
          points.push({
            x: pixel % source.width,
            y: Math.floor(pixel / source.width),
          });
        }
      }
      if (points.length === 0) {
        return { correlation: 0, count: 0, x: 0, y: 0 };
      }
      const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
      const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
      let covariance = 0;
      let varianceX = 0;
      let varianceY = 0;
      for (const point of points) {
        covariance += (point.x - x) * (point.y - y);
        varianceX += (point.x - x) ** 2;
        varianceY += (point.y - y) ** 2;
      }
      return {
        correlation: covariance / Math.sqrt(varianceX * varianceY),
        count: points.length,
        x,
        y,
      };
    });
}

test("adapts the first test_3 import and renders positioned rotated title only in range", async ({
  page,
}, testInfo) => {
  test.setTimeout(2 * 60_000);
  await page.goto("/");
  const portrait = await importAsset(page, "test_3.mp4");
  await portrait.getByRole("button", { name: /添加到时间线/ }).click();
  const cancel = portrait.getByRole("button", { name: "取消代理" });
  if (await cancel.isVisible()) {
    await cancel.click();
  }

  let project = await projectJson(page);
  expect(project.canvas).toMatchObject({ height: 1920, width: 1080 });
  const previewCanvas = page.locator("canvas[data-preview-canvas='pixi-v8']");
  await expect(previewCanvas).toHaveAttribute("width", "304");
  await expect(previewCanvas).toHaveAttribute("height", "540");
  await expect(page.getByTestId("proxy-resolution")).toHaveText("304×540");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedFrames ?? 0,
      ),
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "添加标题" }).click();
  await page.getByLabel("标题文本").fill("TASK17");
  await page.getByLabel("标题字号").fill("180");
  await page.getByLabel("标题颜色").fill("#ff00ff");
  await page.getByLabel("位置 X").fill("0.68");
  await page.getByLabel("位置 Y").fill("0.27");
  await page.getByLabel("旋转").fill("30");
  await page.getByLabel("标题开始时间").fill("1");
  await page.getByLabel("标题结束时间").fill("3");

  const seek = async (value: number) => {
    await page.getByRole("slider", { name: "预览播放头" }).fill(String(value));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__!.getSnapshot().metrics
              .presentedPlayheadUs,
        ),
      )
      .toBe(value);
  };
  await seek(500_000);
  const before = await titlePixelEvidence(page);
  await seek(2_000_000);
  const active = await titlePixelEvidence(page);
  await seek(4_000_000);
  const after = await titlePixelEvidence(page);
  await testInfo.attach("task17-portrait-title-pixels", {
    body: JSON.stringify({ active, after, before }, null, 2),
    contentType: "application/json",
  });

  expect(active.count).toBeGreaterThan(
    Math.max(before.count, after.count) + 50,
  );
  expect(active.x).toBeGreaterThan(160);
  expect(active.x).toBeLessThan(260);
  expect(active.y).toBeGreaterThan(80);
  expect(active.y).toBeLessThan(210);
  expect(active.correlation).toBeGreaterThan(0.15);

  const later = await importAsset(page, "test_1.mp4");
  const laterCancel = later.getByRole("button", { name: "取消代理" });
  if (await laterCancel.isVisible()) {
    await laterCancel.click();
  }
  project = await projectJson(page);
  expect(project.canvas).toMatchObject({ height: 1920, width: 1080 });
});
