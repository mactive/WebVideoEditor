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

async function projectJson(page: Page) {
  await page.getByRole("button", { name: "Project JSON", exact: true }).click();
  const value = await page.getByTestId("project-json").textContent();
  return JSON.parse(value ?? "{}") as {
    clips: Array<{
      id: string;
      assetId: string;
      sourceEndUs: number;
      sourceStartUs: number;
      timelineStartUs: number;
      trackId: string;
      transform?: {
        rotationDeg: number;
        scale: number;
        x: number;
        y: number;
      };
    }>;
    timeline: { durationUs: number };
    tracks: Array<{ id: string; kind: string; name: string; order: number }>;
  };
}

async function blurActiveElement(page: Page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

async function fillInspectorNumber(page: Page, label: string, value: string) {
  const input = page.getByLabel(label);
  await input.fill(value);
  await input.blur();
}

async function dragClipBy(
  page: Page,
  clipId: string,
  delta: { x: number; y: number },
) {
  await page.evaluate(
    ({ clipId, delta }) => {
      const clip = document.querySelector(`[data-clip-id="${clipId}"]`);
      if (!(clip instanceof HTMLElement)) {
        throw new Error(`Clip ${clipId} is not visible`);
      }
      const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
      HTMLElement.prototype.setPointerCapture = () => undefined;
      try {
        const box = clip.getBoundingClientRect();
        const start = {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        };
        clip.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            clientX: start.x,
            clientY: start.y,
            pointerId: 1,
          }),
        );
        clip.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            cancelable: true,
            clientX: start.x + delta.x,
            clientY: start.y + delta.y,
            pointerId: 1,
          }),
        );
        clip.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX: start.x + delta.x,
            clientY: start.y + delta.y,
            pointerId: 1,
          }),
        );
      } finally {
        HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
      }
    },
    { clipId, delta },
  );
}

async function dragClipToTrack(
  page: Page,
  clipId: string,
  trackTestId: string,
) {
  const clip = page.locator(`[data-clip-id="${clipId}"]`).first();
  const [clipBox, trackBox] = await Promise.all([
    clip.boundingBox(),
    page.getByTestId(trackTestId).boundingBox(),
  ]);
  if (!clipBox || !trackBox) {
    throw new Error(`Cannot drag ${clipId} to ${trackTestId}`);
  }
  await dragClipBy(page, clipId, {
    x: 0,
    y: trackBox.y + trackBox.height / 2 - (clipBox.y + clipBox.height / 2),
  });
}

async function dragTrackHeader(
  page: Page,
  sourceLabel: string,
  targetLabel: string,
) {
  await page.evaluate(
    ({ sourceLabel, targetLabel }) => {
      const source = document.querySelector(`[aria-label="${sourceLabel}"]`);
      const target = document.querySelector(`[aria-label="${targetLabel}"]`);
      if (!source || !target) {
        throw new Error(
          `Missing track header ${sourceLabel} or ${targetLabel}`,
        );
      }
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(
        new DragEvent("dragstart", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      target.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
      source.dispatchEvent(
        new DragEvent("dragend", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
        }),
      );
    },
    { sourceLabel, targetLabel },
  );
}

test("adds the same source to V1/V2/A1/A2 with distinct starts and transports all active layers", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  const { mediaItem, panel } = await importTestOneIntoTimeline(page);
  await fillInspectorNumber(page, "时间线起点（秒）", "0.1");

  await mediaItem.getByRole("button", { name: "添加音频到时间线" }).click();
  await fillInspectorNumber(page, "时间线起点（秒）", "0.2");

  await page.getByRole("button", { name: "新增视频轨" }).click();
  await expect(
    page.getByRole("button", { exact: true, name: "V2 视频 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await mediaItem.getByRole("button", { name: /添加到时间线/ }).click();
  await fillInspectorNumber(page, "时间线起点（秒）", "0.3");
  await expect(page.getByTestId("video-track-video-track")).toContainText(
    "test_1.mp4",
  );
  await expect(page.getByTestId("video-track-video-track-2")).toContainText(
    "test_1.mp4",
  );

  await page.getByLabel("片段位置 X").fill("0.68");
  await page.getByLabel("片段位置 Y").fill("0.62");
  await page.getByLabel("片段缩放").fill("0.58");
  await page.getByLabel("片段旋转").fill("18");

  await page.getByRole("button", { name: "新增音频轨" }).click();
  await expect(
    page.getByRole("button", { exact: true, name: "A2 音频 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await mediaItem.getByRole("button", { name: "添加音频到时间线" }).click();
  await fillInspectorNumber(page, "时间线起点（秒）", "0.4");
  await expect(page.locator("[data-clip-id]")).toHaveCount(4);
  await expect(page.getByTestId("audio-track")).toContainText("test_1.mp4");
  await expect(page.getByTestId("audio-track-audio-track-2")).toContainText(
    "test_1.mp4",
  );

  const project = await projectJson(page);
  const videoTracks = project.tracks
    .filter((track) => track.kind === "video")
    .sort((left, right) => left.order - right.order);
  const audioTracks = project.tracks
    .filter((track) => track.kind === "audio")
    .sort((left, right) => left.order - right.order);
  const clipByTrack = new Map(
    project.clips.map((clip) => [clip.trackId, clip]),
  );
  expect(videoTracks.map((track) => track.id)).toEqual([
    "video-track",
    "video-track-2",
  ]);
  expect(audioTracks.map((track) => track.id)).toEqual([
    "audio-track",
    "audio-track-2",
  ]);
  expect(project.clips).toHaveLength(4);
  expect(new Set(project.clips.map((clip) => clip.assetId)).size).toBe(1);
  expect([...clipByTrack.keys()].sort()).toEqual([
    "audio-track",
    "audio-track-2",
    "video-track",
    "video-track-2",
  ]);
  expect(clipByTrack.get("video-track")?.timelineStartUs).toBe(100_000);
  expect(clipByTrack.get("audio-track")?.timelineStartUs).toBe(200_000);
  expect(clipByTrack.get("video-track-2")?.timelineStartUs).toBe(300_000);
  expect(clipByTrack.get("audio-track-2")?.timelineStartUs).toBe(400_000);
  expect(clipByTrack.get("video-track-2")?.transform).toMatchObject({
    rotationDeg: 18,
    scale: 0.58,
    x: 0.68,
    y: 0.62,
  });

  const slider = page.getByRole("slider", { name: "预览播放头" });
  await slider.fill("800000");
  await expect.poll(() => previewPlayheadUs(page)).toBe(800_000);
  await expect
    .poll(() =>
      previewSnapshot(page).then(
        (snapshot) => snapshot.metrics.activeVideoLayers,
      ),
    )
    .toBe(2);
  await expect
    .poll(
      async () => Number(await panel.getAttribute("data-presented-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(1);
  expect(await canvasNonBlackPixels(page)).toBeGreaterThan(10_000);

  await blurActiveElement(page);
  await page.keyboard.press("Space");
  await expect
    .poll(() => previewSnapshot(page).then((snapshot) => snapshot.playing))
    .toBe(true);
  await expect
    .poll(() =>
      previewSnapshot(page).then(
        (snapshot) => snapshot.metrics.audioActiveSources,
      ),
    )
    .toBeGreaterThan(1);
  await page.keyboard.press("Space");
  await expect
    .poll(() => previewSnapshot(page).then((snapshot) => snapshot.playing))
    .toBe(false);
  await expect
    .poll(() =>
      previewSnapshot(page).then(
        (snapshot) => snapshot.metrics.audioActiveSources,
      ),
    )
    .toBe(0);
});

test("manages long timeline scale, track order, cross-track moves, and deletion without stale preview references", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await importTestOneIntoTimeline(page);

  await page.getByRole("button", { name: "10min" }).click();
  await page.getByRole("slider", { name: "时间线缩放" }).fill("20");
  await expect(page.getByText("20px/s")).toBeVisible();
  await expect(page.getByTestId("timeline-ruler")).toHaveAttribute(
    "data-duration-us",
    "600000000",
  );

  let project = await projectJson(page);
  expect(project.timeline.durationUs).toBe(600_000_000);
  const clipId = project.clips[0]?.id;
  if (!clipId) {
    throw new Error("Expected imported clip");
  }

  await dragClipBy(page, clipId, { x: 260, y: 0 });
  await expect
    .poll(async () => {
      const updated = await projectJson(page);
      return (
        updated.clips.find((clip) => clip.id === clipId)?.timelineStartUs ?? -1
      );
    })
    .toBeGreaterThanOrEqual(12_000_000);

  await page.getByRole("button", { name: "新增视频轨" }).click();
  await dragTrackHeader(page, "轨道头 V2 视频 2", "轨道头 V1 视频");
  project = await projectJson(page);
  const orderByTrackId = new Map(
    project.tracks.map((track) => [track.id, track.order]),
  );
  const reorderedVideoTrack = orderByTrackId.get("video-track-2");
  const baseVideoTrack = orderByTrackId.get("video-track");
  expect(reorderedVideoTrack).toBeDefined();
  expect(baseVideoTrack).toBeDefined();
  expect(reorderedVideoTrack!).toBeLessThan(baseVideoTrack!);

  await dragClipToTrack(page, clipId, "video-track-video-track-2");
  await expect
    .poll(async () => {
      const updated = await projectJson(page);
      return updated.clips.find((clip) => clip.id === clipId)?.trackId;
    })
    .toBe("video-track-2");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("包含 1 个内容");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "删除轨道 V1 视频 2" }).click();

  await expect
    .poll(async () => {
      const updated = await projectJson(page);
      return {
        clipTracks: updated.clips.map((clip) => clip.trackId),
        trackIds: updated.tracks.map((track) => track.id),
      };
    })
    .toEqual({
      clipTracks: [],
      trackIds: ["video-track", "audio-track", "text-track"],
    });
  await expect
    .poll(() =>
      previewSnapshot(page).then(
        (snapshot) => snapshot.metrics.activeVideoLayers,
      ),
    )
    .toBe(0);
});

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
  await expect(panel).toHaveAttribute("data-decode-hwm", "8");

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
