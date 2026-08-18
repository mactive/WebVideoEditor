import type { PreviewRuntimeSnapshot } from "@web-video-editor/preview-runtime";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

type PreviewDiagnosticsWindow = Window & {
  __TASK_8_PREVIEW__?: {
    getSnapshot(): PreviewRuntimeSnapshot;
  };
};

async function canvasNonBlackPixels(page: Page) {
  return page
    .locator("canvas[data-preview-canvas='pixi-v8']")
    .evaluate((canvas) => {
      const source = canvas as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d");
      context?.drawImage(source, 0, 0);
      const data = context?.getImageData(0, 0, copy.width, copy.height).data;
      let nonBlack = 0;
      if (data) {
        for (let index = 0; index < data.length; index += 4) {
          const sum =
            (data[index] ?? 0) +
            (data[index + 1] ?? 0) +
            (data[index + 2] ?? 0);
          if (sum > 30) {
            nonBlack += 1;
          }
        }
      }
      return nonBlack;
    });
}

async function importTestOneIntoTimeline(page: Page) {
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const mediaItem = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(mediaItem).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  const cancelProxy = mediaItem.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }
  await mediaItem.getByRole("button", { name: /添加到时间线/ }).click();

  const panel = page.locator(".preview-panel");
  await expect(panel).toHaveAttribute("data-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => Number(await panel.getAttribute("data-presented-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  return { mediaItem, panel };
}

async function previewSnapshot(page: Page) {
  return page.evaluate(() =>
    (window as PreviewDiagnosticsWindow).__TASK_8_PREVIEW__!.getSnapshot(),
  );
}

async function previewPlayheadUs(page: Page) {
  return previewSnapshot(page).then((snapshot) => snapshot.metrics.playheadUs);
}

async function blurActiveElement(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

test("keeps the direct preview frame visible when proxy becomes ready", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await expect(page.getByTestId("structured-log-toggle")).toHaveText(
    "日志关闭",
  );
  await page.getByRole("button", { name: "清理代理缓存" }).click();
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const mediaItem = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(mediaItem).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await mediaItem.getByRole("button", { name: /添加到时间线/ }).click();

  const panel = page.locator(".preview-panel");
  await expect(panel).toHaveAttribute("data-ready", "true", {
    timeout: 60_000,
  });
  await expect
    .poll(
      async () => Number(await panel.getAttribute("data-presented-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  expect(await canvasNonBlackPixels(page)).toBeGreaterThan(10_000);

  await expect(mediaItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 4 * 60_000 },
  );
  expect(await canvasNonBlackPixels(page)).toBeGreaterThan(10_000);
  await expect
    .poll(
      async () => Number(await panel.getAttribute("data-presented-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(1);
  expect(await canvasNonBlackPixels(page)).toBeGreaterThan(10_000);
  expect(
    await page.evaluate(() => window.__TASK_14_RUNTIME__?.getLogs().length),
  ).toBe(0);
});

test("main editor preview shortcuts, metrics disclosure, and narrow layout work", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  await page.goto("/");
  await importTestOneIntoTimeline(page);

  await blurActiveElement(page);
  await page.keyboard.press("Space");
  await expect
    .poll(() => previewSnapshot(page).then((snapshot) => snapshot.playing))
    .toBe(true);
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible();

  await page.keyboard.press("Space");
  await expect
    .poll(() => previewSnapshot(page).then((snapshot) => snapshot.playing))
    .toBe(false);
  await expect(
    page.getByRole("button", { name: "播放", exact: true }),
  ).toBeVisible();

  const slider = page.getByRole("slider", { name: "预览播放头" });
  await slider.fill("500000");
  await expect.poll(() => previewPlayheadUs(page)).toBe(500_000);
  await blurActiveElement(page);

  const beforeNextFrame = await previewPlayheadUs(page);
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => previewPlayheadUs(page))
    .toBeGreaterThan(beforeNextFrame);

  const afterNextFrame = await previewPlayheadUs(page);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => previewPlayheadUs(page)).toBeLessThan(afterNextFrame);

  await slider.fill("500000");
  await expect.poll(() => previewPlayheadUs(page)).toBe(500_000);
  await slider.focus();
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.ariaLabel === "预览播放头"),
    )
    .toBe(true);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => previewPlayheadUs(page)).toBeLessThanOrEqual(501_000);

  const metricsToggle = page.getByTestId("preview-metrics-toggle");
  const metricsDetails = page.locator("#preview-metrics-details");
  await expect(metricsToggle).toHaveAttribute("aria-expanded", "true");
  await expect(metricsDetails).toBeVisible();
  await metricsToggle.click();
  await expect(metricsToggle).toHaveAttribute("aria-expanded", "false");
  await expect(metricsDetails).toBeHidden();

  const metricsSummaryText =
    (await page.getByTestId("preview-metrics-summary").textContent()) ?? "";
  expect(metricsSummaryText).toContain("Source");
  expect(metricsSummaryText).toContain("FPS");
  expect(metricsSummaryText).toMatch(/JS Heap (used|N\/A)/);

  await page.setViewportSize({ width: 390, height: 900 });
  const panel = page.locator(".preview-panel");
  await panel.scrollIntoViewIfNeeded();

  await expect(
    page.getByRole("button", { name: "播放", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "暂停", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "暂停", exact: true }).click();

  await expect(
    page.getByRole("button", { name: "上一帧", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "上一帧", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下一帧", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一帧", exact: true }).click();
  await expect(slider).toBeVisible();
  await slider.fill("250000");
  await expect.poll(() => previewPlayheadUs(page)).toBe(250_000);

  await expect(metricsToggle).toBeVisible();
  await metricsToggle.click();
  await expect(metricsToggle).toHaveAttribute("aria-expanded", "true");

  const layout = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing layout target: ${selector}`);
      }
      const box = element.getBoundingClientRect();
      return {
        bottom: box.bottom + window.scrollY,
        height: box.height,
        left: box.left + window.scrollX,
        right: box.right + window.scrollX,
        top: box.top + window.scrollY,
        width: box.width,
      };
    };
    return {
      controls: rect(".editor__preview .preview-panel__controls"),
      inspector: rect(".inspector"),
      metricsHeader: rect(".editor__preview .preview-panel__metrics-header"),
      timeline: rect(".timeline"),
      viewportWidth: window.innerWidth,
    };
  });
  const previewInteractiveBottom = Math.max(
    layout.controls.bottom,
    layout.metricsHeader.bottom,
  );
  expect(previewInteractiveBottom).toBeLessThanOrEqual(layout.inspector.top);
  expect(layout.inspector.bottom).toBeLessThanOrEqual(layout.timeline.top);
  for (const box of [
    layout.controls,
    layout.inspector,
    layout.metricsHeader,
    layout.timeline,
  ]) {
    expect(box.width).toBeLessThanOrEqual(layout.viewportWidth);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(layout.viewportWidth);
  }
});

test("renders test_1 proxy, keeps latest seek, and releases frames", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const mediaItem = page.locator(".media-panel__results > li").first();
  await expect(mediaItem.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 8 * 60_000 },
  );

  await page.goto("/preview.html");
  const panel = page.locator(".preview-panel");
  await expect(panel).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
  await expect(
    page.locator("canvas[data-preview-canvas='pixi-v8']"),
  ).toBeVisible();
  await expect(page.getByTestId("proxy-resolution")).toHaveText("540×540");
  await expect
    .poll(async () => Number(await panel.getAttribute("data-presented-frames")))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect(page.getByRole("button", { name: "暂停" })).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("preview-fps")
        .textContent()
        .then((value) => Number(value)),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "暂停" }).click();

  const playhead = page.getByRole("slider", { name: "预览播放头" });
  for (const value of [
    2_000_000, 18_000_000, 4_000_000, 25_000_000, 7_000_000, 12_000_000,
  ]) {
    await playhead.fill(String(value));
  }
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedPlayheadUs,
      ),
    )
    .toBe(12_000_000);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getResources().byType["video-frame"]
            .active,
      ),
    )
    .toBe(0);
  await expect(panel).toHaveAttribute("data-decode-active", "0");
  await expect(panel).toHaveAttribute("data-decode-queued", "0");
  await expect(panel).toHaveAttribute("data-decode-hwm", "1");

  const pixels = await page.locator("canvas").evaluate((canvas) => {
    const source = canvas as HTMLCanvasElement;
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    const context = copy.getContext("2d");
    context?.drawImage(source, 0, 0);
    const data = context?.getImageData(0, 0, copy.width, copy.height).data;
    let nonBlack = 0;
    let brightTitlePixels = 0;
    if (data) {
      for (let index = 0; index < data.length; index += 4) {
        const sum =
          (data[index] ?? 0) + (data[index + 1] ?? 0) + (data[index + 2] ?? 0);
        if (sum > 30) {
          nonBlack += 1;
        }
        const pixel = index / 4;
        const y = Math.floor(pixel / copy.width);
        if (y < copy.height * 0.22 && sum > 690) {
          brightTitlePixels += 1;
        }
      }
    }
    return { brightTitlePixels, nonBlack };
  });
  expect(pixels.nonBlack).toBeGreaterThan(10_000);
  expect(pixels.brightTitlePixels).toBeGreaterThan(50);

  const released = await page.evaluate(() => {
    window.__TASK_8_PREVIEW__?.dispose();
    return window.__TASK_8_PREVIEW__?.getResources().activeTotal;
  });
  expect(released).toBe(0);
});
