import { expect, test, type Page } from "@playwright/test";

type PixelSample = {
  pixels: number[];
  playheadUs: number;
};

async function importTestOne(page: Page) {
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await expect(item).toContainText("AVC");
  await expect(item).toContainText("720×720");
  await expect(item).toContainText("MJPEG");
  await expect(item).toContainText("UrlSource");
  const cancelProxy = item.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  const preview = page.locator(".preview-panel");
  await expect(preview).toHaveAttribute("data-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => Number(await preview.getAttribute("data-presented-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return { item, preview };
}

async function samplePreview(page: Page): Promise<PixelSample> {
  return page
    .locator("canvas[data-preview-canvas='pixi-v8']")
    .evaluate((canvas) => {
      const source = canvas as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Pixel sampling context is unavailable");
      }
      context.drawImage(source, 0, 0);
      const data = context.getImageData(0, 0, copy.width, copy.height).data;
      const pixels: number[] = [];
      for (let y = 0; y < copy.height; y += 8) {
        for (let x = 0; x < copy.width; x += 8) {
          const offset = (y * copy.width + x) * 4;
          pixels.push(
            data[offset] ?? 0,
            data[offset + 1] ?? 0,
            data[offset + 2] ?? 0,
          );
        }
      }
      return {
        pixels,
        playheadUs:
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics
            .presentedPlayheadUs ?? -1,
      };
    });
}

async function applyEffectAndSample(
  page: Page,
  kind: "adjustments" | "grayscale" | "none" | "vintage",
  fixedPlayheadUs: number,
): Promise<PixelSample> {
  const before = await page.evaluate(
    () => window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedFrames ?? 0,
  );
  await page.getByLabel("滤镜类型").selectOption(kind);
  if (kind === "adjustments") {
    await page.getByLabel("亮度").fill("0.45");
    await page.getByLabel("对比度").fill("0.65");
  }
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedFrames ??
            0,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(before);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__?.getSnapshot().metrics
              .presentedPlayheadUs,
        ),
      { timeout: 60_000 },
    )
    .toBe(fixedPlayheadUs);
  return samplePreview(page);
}

function meanAbsoluteDifference(left: number[], right: number[]): number {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs((left[index] ?? 0) - (right[index] ?? 0));
  }
  return difference / left.length;
}

function meanChroma(pixels: number[]): number {
  let chroma = 0;
  for (let index = 0; index < pixels.length; index += 3) {
    const channels = [
      pixels[index] ?? 0,
      pixels[index + 1] ?? 0,
      pixels[index + 2] ?? 0,
    ];
    chroma += Math.max(...channels) - Math.min(...channels);
  }
  return chroma / (pixels.length / 3);
}

test.describe.configure({ mode: "serial" });

test("Task 14 runtime queues, honest codec observations, and fixed-frame pixels", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "总编辑器", exact: true }),
  ).toBeVisible();
  await importTestOne(page);

  const importEvidence = await page.evaluate(() => {
    const queue = window.__TASK_14_MEDIA__?.getImportQueue();
    const queueLogs =
      window.__TASK_14_RUNTIME__
        ?.getLogs()
        .filter(
          (entry) =>
            entry.marker === "[IMPORT]" && entry.event === "queue.state",
        ) ?? [];
    const completed = window.__TASK_14_RUNTIME__
      ?.getLogs()
      .find(
        (entry) =>
          entry.marker === "[IMPORT]" && entry.event === "probe.completed",
      );
    return { completed, queue, queueLogs };
  });
  expect(importEvidence.queue).toMatchObject({
    active: 0,
    activePeak: 1,
    concurrency: 1,
    highWatermark: 2,
    queued: 0,
  });
  expect(importEvidence.queue?.queuedPeak).toBeLessThanOrEqual(2);
  expect(importEvidence.queueLogs.length).toBeGreaterThanOrEqual(3);
  expect(importEvidence.completed).toBeTruthy();
  expect(importEvidence.completed?.output).toMatchObject({
    read: {
      adapter: "UrlSource",
      fullFileRead: false,
      mode: "on-demand",
    },
  });

  await page.locator("[data-clip-id]").first().click();
  const fixedPlayheadUs = 2_000_000;
  await page
    .getByRole("slider", { name: "预览播放头" })
    .fill(String(fixedPlayheadUs));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedPlayheadUs,
      ),
    )
    .toBe(fixedPlayheadUs);

  const none = await samplePreview(page);
  const grayscale = await applyEffectAndSample(
    page,
    "grayscale",
    fixedPlayheadUs,
  );
  const vintage = await applyEffectAndSample(page, "vintage", fixedPlayheadUs);
  const adjustments = await applyEffectAndSample(
    page,
    "adjustments",
    fixedPlayheadUs,
  );
  const restored = await applyEffectAndSample(page, "none", fixedPlayheadUs);
  for (const sample of [none, grayscale, vintage, adjustments, restored]) {
    expect(sample.playheadUs).toBe(fixedPlayheadUs);
  }
  const pixelMetrics = {
    adjustmentsFromNone: meanAbsoluteDifference(
      none.pixels,
      adjustments.pixels,
    ),
    grayscaleChroma: meanChroma(grayscale.pixels),
    grayscaleFromNone: meanAbsoluteDifference(none.pixels, grayscale.pixels),
    noneChroma: meanChroma(none.pixels),
    restoredFromNone: meanAbsoluteDifference(none.pixels, restored.pixels),
    vintageFromGrayscale: meanAbsoluteDifference(
      grayscale.pixels,
      vintage.pixels,
    ),
    vintageFromNone: meanAbsoluteDifference(none.pixels, vintage.pixels),
  };
  expect(pixelMetrics.grayscaleFromNone).toBeGreaterThan(1);
  expect(pixelMetrics.vintageFromNone).toBeGreaterThan(1);
  expect(pixelMetrics.adjustmentsFromNone).toBeGreaterThan(1);
  expect(pixelMetrics.vintageFromGrayscale).toBeGreaterThan(1);
  expect(pixelMetrics.grayscaleChroma).toBeLessThan(pixelMetrics.noneChroma);
  expect(pixelMetrics.restoredFromNone).toBeLessThan(1);

  await page.getByLabel("源出点（秒）").fill("1");
  await page.getByRole("button", { name: "开始导出" }).click();
  await expect(page.getByTestId("export-panel")).toHaveAttribute(
    "data-export-status",
    "completed",
    { timeout: 3 * 60_000 },
  );
  const exportEvidence = await page.evaluate(() => ({
    result: window.__TASK_11_EXPORT__?.getResult(),
    taskQueue: window.__TASK_11_EXPORT__?.getTaskQueue(),
  }));
  expect(exportEvidence.taskQueue).toMatchObject({
    active: 0,
    activePeak: 1,
    concurrency: 1,
    highWatermark: 1,
    queued: 0,
  });
  const codecQueues = exportEvidence.result?.codecQueues;
  for (const decoder of [
    codecQueues?.videoDecoder,
    codecQueues?.audioDecoder,
  ]) {
    expect(decoder?.internalQueue).toMatchObject({
      available: false,
      highWatermark: null,
      peak: null,
      queueSize: null,
    });
    expect(decoder?.applicationQueue.activePeak).toBeLessThanOrEqual(
      decoder?.applicationQueue.concurrency ?? 0,
    );
    expect(decoder?.applicationQueue.queuedPeak).toBeLessThanOrEqual(
      decoder?.applicationQueue.highWatermark ?? 0,
    );
  }
  for (const encoder of [
    codecQueues?.videoEncoder,
    codecQueues?.audioEncoder,
  ]) {
    expect(encoder?.internalQueue.available).toBe(true);
    expect(encoder?.internalQueue.queueSize).toBe(0);
    expect(encoder?.internalQueue.peak).toBeLessThanOrEqual(
      encoder?.internalQueue.highWatermark ?? 0,
    );
  }
  console.info(
    `[TASK14_RUNTIME_EVIDENCE] ${JSON.stringify({
      codecQueues,
      importQueue: importEvidence.queue,
      pixelMetrics,
      taskQueue: exportEvidence.taskQueue,
    })}`,
  );
});

test("Task 14 keeps bounded decoder state stable after 120 seconds of rapid seek", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  await page.goto("/");
  await importTestOne(page);

  const stress = await page.evaluate(async () => {
    const runtime = window.__TASK_8_PREVIEW__;
    if (!runtime) {
      throw new Error("Preview diagnostics are unavailable");
    }
    const startedAt = performance.now();
    let requests = 0;
    while (performance.now() - startedAt < 120_000) {
      const phase = requests % 300;
      runtime.seek(((phase * 97_531) % 35_000_000) + 100_000);
      runtime.seek(((phase * 193_939) % 35_000_000) + 200_000);
      runtime.seek(((phase * 389_171) % 35_000_000) + 300_000);
      requests += 3;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const finalPlayheadUs = 12_345_678;
    runtime.seek(finalPlayheadUs);
    return {
      elapsedMs: performance.now() - startedAt,
      finalPlayheadUs,
      requests,
    };
  });
  expect(stress.elapsedMs).toBeGreaterThanOrEqual(120_000);
  expect(stress.requests).toBeGreaterThan(600);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__?.getSnapshot().metrics
              .presentedPlayheadUs,
        ),
      { timeout: 60_000 },
    )
    .toBe(stress.finalPlayheadUs);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics.codecQueues
            .videoDecoder.applicationQueue,
      ),
    )
    .toMatchObject({ active: 0, queued: 0 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getResources().byType["video-frame"]
            .active,
      ),
    )
    .toBe(0);

  const evidence = await page.evaluate(() => {
    const snapshot = window.__TASK_8_PREVIEW__?.getSnapshot();
    return {
      audioActiveSources: snapshot?.metrics.audioActiveSources,
      decoder: snapshot?.metrics.codecQueues.videoDecoder.applicationQueue,
      droppedFrames: snapshot?.metrics.droppedFrames,
      staleFrames: snapshot?.metrics.staleFrames,
      videoFrames:
        window.__TASK_8_PREVIEW__?.getResources().byType["video-frame"],
    };
  });
  expect(evidence.decoder?.activePeak).toBeLessThanOrEqual(
    evidence.decoder?.concurrency ?? 0,
  );
  expect(evidence.decoder?.queuedPeak).toBeLessThanOrEqual(
    evidence.decoder?.highWatermark ?? 0,
  );
  expect(evidence.decoder?.backpressureCount).toBeGreaterThan(0);
  expect(
    (evidence.droppedFrames ?? 0) + (evidence.staleFrames ?? 0),
  ).toBeGreaterThan(0);
  expect(evidence.audioActiveSources).toBe(0);
  expect(evidence.videoFrames?.active).toBe(0);
  console.info(
    `[TASK14_SEEK_120S_EVIDENCE] ${JSON.stringify({ ...stress, ...evidence })}`,
  );
});
