import { expect, test } from "@playwright/test";

test("OPFS explorer lists proxy files and previews manifest JSON", async ({
  page,
}) => {
  await page.goto("/opfs");
  await expect(
    page.getByRole("heading", { name: "OPFS 查看器" }),
  ).toBeVisible();

  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry("web-video-editor-media-cache-v1", {
        recursive: true,
      });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }
    const cache = await root.getDirectoryHandle(
      "web-video-editor-media-cache-v1",
      { create: true },
    );
    const proxy = await cache.getDirectoryHandle("proxy-test-viewer", {
      create: true,
    });
    const manifest = {
      cacheKey: "proxy-test-viewer",
      cover: {
        byteLength: 4,
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
          byteLength: 1024,
          durationSec: 0.033333,
          sequenceNumber: 0,
          timestampSec: 0,
        },
      ],
      parameters: {
        frameRate: 30,
        keyFrameIntervalSec: 2,
      },
      proxy: {
        byteLength: 12,
        durationSec: 2,
        frameRate: 30,
        height: 540,
        mimeType: "video/mp4",
        path: "proxy.mp4",
        width: 960,
      },
      source: {
        durationSec: 2,
        height: 1080,
        width: 1920,
      },
      thumbnails: [],
      version: 1,
      waveform: {
        bucketCount: 512,
        byteLength: 6144,
        mimeType: "application/x-float32",
        path: "waveform.f32",
        sampleCount: 96000,
      },
    };
    const file = await proxy.getFileHandle("manifest.json", { create: true });
    const writable = await file.createWritable();
    await writable.write(JSON.stringify(manifest));
    await writable.close();
  });

  await page.getByRole("button", { name: "刷新" }).click();
  await expect(page.locator(".opfs-summary")).toContainText(
    "1 proxy manifests",
  );
  await expect(page.locator(".opfs-proxy-grid")).toContainText(
    "proxy-test-viewer",
  );

  await page.getByRole("button", { name: /manifest\.json/ }).click();
  await expect(page.locator(".opfs-preview")).toContainText(
    '"cacheKey": "proxy-test-viewer"',
  );
});
