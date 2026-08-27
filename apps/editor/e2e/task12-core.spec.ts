import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function projectJson(page: Page) {
  await page.getByRole("button", { name: "Project JSON", exact: true }).click();
  return JSON.parse(
    (await page.getByTestId("project-json").textContent()) ?? "{}",
  ) as {
    assets: Array<{ durationUs: number; id: string; name: string }>;
    clips: Array<{
      effects: Array<{ amount?: number; kind: string }>;
      id: string;
      sourceEndUs: number;
      sourceStartUs: number;
      timelineStartUs: number;
      trackId: string;
    }>;
    texts: Array<{ endUs: number; startUs: number; text: string }>;
  };
}

async function importTestOne(page: Page) {
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  return item;
}

async function addTestOneVideo(page: Page) {
  const item = await importTestOne(page);
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  const cancelProxy = item.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }
  return item;
}

async function dragClipBy(page: Page, clipId: string, deltaX: number) {
  await page.evaluate(
    ({ clipId, deltaX }) => {
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
            clientX: start.x + deltaX,
            clientY: start.y,
            pointerId: 1,
          }),
        );
        clip.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX: start.x + deltaX,
            clientY: start.y,
            pointerId: 1,
          }),
        );
      } finally {
        HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
      }
    },
    { clipId, deltaX },
  );
}

async function dragTrimHandleBy(
  page: Page,
  clipId: string,
  edge: "end" | "start",
  deltaX: number,
) {
  await page.evaluate(
    ({ clipId, deltaX, edge }) => {
      const clip = document.querySelector(`[data-clip-id="${clipId}"]`);
      if (!(clip instanceof HTMLElement)) {
        throw new Error(`Clip ${clipId} is not visible`);
      }
      const handle = clip.querySelector(`.timeline__trim--${edge}`);
      if (!(handle instanceof HTMLElement)) {
        throw new Error(`Trim handle ${edge} for ${clipId} is not visible`);
      }
      const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
      HTMLElement.prototype.setPointerCapture = () => undefined;
      try {
        const box = handle.getBoundingClientRect();
        const start = {
          x: box.left + box.width / 2,
          y: box.top + box.height / 2,
        };
        handle.dispatchEvent(
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
            clientX: start.x + deltaX,
            clientY: start.y,
            pointerId: 1,
          }),
        );
        clip.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            clientX: start.x + deltaX,
            clientY: start.y,
            pointerId: 1,
          }),
        );
      } finally {
        HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
      }
    },
    { clipId, deltaX, edge },
  );
}

test("Task 12 core: capability, import, edit, seek, history, and real export", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const response = await page.goto("/");
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe(
    "require-corp",
  );
  await expect(
    page.getByRole("heading", { name: "总编辑器", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "能力", exact: true }).click();
  await expect(page.locator("[data-capability-id]")).toHaveCount(12);
  for (const capability of [
    "crossOriginIsolated",
    "worker",
    "opfs",
    "h264Decode",
    "h264Encode",
    "aacEncode",
  ]) {
    await expect(
      page.locator(`[data-capability-id="${capability}"]`),
      `capability ${capability}`,
    ).toHaveAttribute("data-supported", "true", { timeout: 30_000 });
  }

  await page.getByRole("button", { name: "清理代理缓存" }).click();
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await expect(item).toContainText("UrlSource");
  await expect(item).toContainText("MJPEG");
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  const cancelProxy = item.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
    await expect(item.locator(".proxy-progress")).toHaveAttribute(
      "data-status",
      "cancelled",
    );
  }

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

  await page.locator("[data-clip-id]").first().click();
  await page.getByLabel("源入点（秒）").fill("0.5");
  await page.getByLabel("源出点（秒）").fill("1.1");
  await page.getByLabel("滤镜类型").selectOption("vintage");
  await page.getByLabel("滤镜强度").fill("0.8");
  await page.getByRole("button", { name: "添加标题" }).click();
  await page.getByLabel("标题文本").fill("TASK 12");
  await page.getByLabel("标题字号").fill("88");
  await page.getByLabel("标题结束时间").fill("0.6");

  let project = await projectJson(page);
  expect(project.clips[0]).toMatchObject({
    sourceEndUs: 1_100_000,
    sourceStartUs: 500_000,
  });
  expect(project.clips[0]?.effects[0]).toMatchObject({
    amount: 0.8,
    kind: "vintage",
  });
  expect(project.texts[0]?.text).toBe("TASK 12");

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  project = await projectJson(page);
  expect(project.texts[0]?.endUs).toBe(60_000_000);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  project = await projectJson(page);
  expect(project.texts[0]).toMatchObject({ endUs: 600_000, text: "TASK 12" });

  const playhead = page.getByRole("slider", { name: "预览播放头" });
  for (const value of [50_000, 550_000, 100_000, 500_000, 250_000]) {
    await playhead.fill(String(value));
  }
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
    .toBe(250_000);
  await expect(preview).toHaveAttribute("data-decode-active", "0");
  await expect(preview).toHaveAttribute("data-decode-queued", "0");
  await expect(preview).toHaveAttribute("data-decode-hwm", "8");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__TASK_8_PREVIEW__?.getResources().byType["video-frame"]
            .active,
      ),
    )
    .toBe(0);

  const exportPanel = page.getByTestId("export-panel");
  await page.getByRole("button", { name: "开始导出" }).click();
  await expect(exportPanel).toHaveAttribute("data-export-status", "completed", {
    timeout: 3 * 60_000,
  });
  const result = await page.evaluate(() =>
    window.__TASK_11_EXPORT__?.getResult(),
  );
  expect(result).toMatchObject({
    durationUs: 60_000_000,
    frames: 1800,
    height: 1080,
    mimeType: "video/mp4",
    source: "original",
    width: 1920,
  });
  expect(result?.bytes).toBeGreaterThan(10_000);
  expect(result?.resources.activeTotal).toBe(0);
  expect(result?.resources.byType["video-frame"]).toMatchObject({
    active: 0,
    created: 1800,
    released: 1800,
  });
  expect(result?.resources.byType["audio-data"].active).toBe(0);
  expect(result?.queue.videoPeak).toBeLessThanOrEqual(
    result?.queue.highWatermark ?? 0,
  );
  expect(result?.queue.audioPeak).toBeLessThanOrEqual(
    result?.queue.highWatermark ?? 0,
  );
  expect(typeof result?.heap.available).toBe("boolean");

  const diagnostics = await page.evaluate(async () => {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    const estimate = await navigator.storage.estimate();
    const directory = await (
      await navigator.storage.getDirectory()
    ).getDirectoryHandle("web-video-editor-exports-v1");
    const files: Array<{ name: string; size: number }> = [];
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === "file") {
        files.push({ name, size: (await handle.getFile()).size });
      }
    }
    const exported = await window.__TASK_11_EXPORT__?.getFile();
    if (!exported) {
      throw new Error("Task 12 export file is missing");
    }
    const url = URL.createObjectURL(exported);
    const video = document.createElement("video");
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(video.error ?? new Error("decode failed"));
    });
    const decoded = {
      duration: video.duration,
      height: video.videoHeight,
      width: video.videoWidth,
    };
    URL.revokeObjectURL(url);
    return {
      decoded,
      files,
      heapBytes: memory?.usedJSHeapSize,
      quotaBytes: estimate.quota,
      usageBytes: estimate.usage,
    };
  });
  expect(diagnostics.heapBytes).toBeGreaterThan(0);
  expect(diagnostics.usageBytes).toBeGreaterThanOrEqual(result?.bytes ?? 0);
  expect(diagnostics.quotaBytes).toBeGreaterThan(diagnostics.usageBytes ?? 0);
  expect(diagnostics.files.some((file) => file.name.startsWith(".tmp-"))).toBe(
    false,
  );
  expect(diagnostics.decoded).toMatchObject({ height: 1080, width: 1920 });
  expect(diagnostics.decoded.duration).toBeGreaterThan(59.9);
  expect(diagnostics.decoded.duration).toBeLessThan(60.2);
  expect(pageErrors).toEqual([]);
});

test("Task 6: trims video/audio clips and protects Inspector time inputs", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  await page.goto("/");

  const mediaItem = await addTestOneVideo(page);
  let project = await projectJson(page);
  const videoId = project.clips.find(
    (clip) => clip.trackId === "video-track",
  )?.id;
  if (!videoId) {
    throw new Error("Expected a video clip on the primary video track");
  }

  await dragTrimHandleBy(page, videoId, "start", 80);
  project = await projectJson(page);
  let videoClip = project.clips.find((clip) => clip.id === videoId);
  expect(videoClip).toMatchObject({
    sourceStartUs: 1_000_000,
    timelineStartUs: 1_000_000,
  });
  const afterVideoLeft = videoClip!;

  await dragTrimHandleBy(page, videoId, "end", -80);
  project = await projectJson(page);
  videoClip = project.clips.find((clip) => clip.id === videoId);
  expect(videoClip).toMatchObject({
    sourceEndUs: afterVideoLeft.sourceEndUs - 1_000_000,
    sourceStartUs: afterVideoLeft.sourceStartUs,
    timelineStartUs: afterVideoLeft.timelineStartUs,
  });

  await page.locator(`[data-clip-id="${videoId}"]`).click();
  const beforeDurationEdit = videoClip!;
  const extendedDurationSeconds =
    (beforeDurationEdit.sourceEndUs -
      beforeDurationEdit.sourceStartUs +
      500_000) /
    1_000_000;
  await page
    .getByLabel("片段时长（秒）")
    .fill(extendedDurationSeconds.toFixed(6));
  await page.getByLabel("片段时长（秒）").blur();
  project = await projectJson(page);
  videoClip = project.clips.find((clip) => clip.id === videoId);
  expect(videoClip).toMatchObject({
    sourceEndUs: beforeDurationEdit.sourceEndUs + 500_000,
    sourceStartUs: beforeDurationEdit.sourceStartUs,
    timelineStartUs: beforeDurationEdit.timelineStartUs,
  });

  const beforeInvalidInput = videoClip!;
  await page.getByLabel("源入点（秒）").fill("-1");
  await expect(page.getByRole("status")).toContainText("请输入非负秒数。");
  project = await projectJson(page);
  expect(project.clips.find((clip) => clip.id === videoId)).toMatchObject(
    beforeInvalidInput,
  );

  await mediaItem.getByRole("button", { name: "添加音频到时间线" }).click();
  project = await projectJson(page);
  const audioId = project.clips.find(
    (clip) => clip.trackId === "audio-track",
  )?.id;
  if (!audioId) {
    throw new Error("Expected an audio clip on the primary audio track");
  }

  await dragTrimHandleBy(page, audioId, "start", 80);
  project = await projectJson(page);
  let audioClip = project.clips.find((clip) => clip.id === audioId);
  expect(audioClip).toMatchObject({
    sourceStartUs: 1_000_000,
    timelineStartUs: 1_000_000,
  });
  const afterAudioLeft = audioClip!;

  await dragTrimHandleBy(page, audioId, "end", -80);
  project = await projectJson(page);
  audioClip = project.clips.find((clip) => clip.id === audioId);
  expect(audioClip).toMatchObject({
    sourceEndUs: afterAudioLeft.sourceEndUs - 1_000_000,
    sourceStartUs: afterAudioLeft.sourceStartUs,
    timelineStartUs: afterAudioLeft.timelineStartUs,
  });
});

test("Task 6: moves a split clip and restores it with Undo/Redo", async ({
  page,
}) => {
  test.setTimeout(3 * 60_000);
  await page.goto("/");

  await addTestOneVideo(page);
  let project = await projectJson(page);
  const originalClipId = project.clips[0]?.id;
  if (!originalClipId) {
    throw new Error("Expected an imported clip before splitting");
  }

  await page.locator(`[data-clip-id="${originalClipId}"]`).click();
  await page.getByRole("slider", { name: "时间线播放头" }).fill("2000000");
  await page.getByRole("button", { name: "播放头分割" }).click();
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);

  project = await projectJson(page);
  const rightClip = project.clips.find(
    (clip) =>
      clip.trackId === "video-track" && clip.sourceStartUs === 2_000_000,
  );
  if (!rightClip) {
    throw new Error("Expected the right split clip");
  }
  await expect(page.locator(`[data-clip-id="${rightClip.id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await dragClipBy(page, rightClip.id, 80);
  project = await projectJson(page);
  expect(project.clips.find((clip) => clip.id === rightClip.id)).toMatchObject({
    sourceEndUs: rightClip.sourceEndUs,
    sourceStartUs: rightClip.sourceStartUs,
    timelineStartUs: 3_000_000,
    trackId: "video-track",
  });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  project = await projectJson(page);
  expect(project.clips.find((clip) => clip.id === rightClip.id)).toMatchObject({
    sourceEndUs: rightClip.sourceEndUs,
    sourceStartUs: rightClip.sourceStartUs,
    timelineStartUs: 2_000_000,
    trackId: "video-track",
  });

  await page.getByRole("button", { name: "Redo", exact: true }).click();
  project = await projectJson(page);
  expect(project.clips.find((clip) => clip.id === rightClip.id)).toMatchObject({
    sourceEndUs: rightClip.sourceEndUs,
    sourceStartUs: rightClip.sourceStartUs,
    timelineStartUs: 3_000_000,
    trackId: "video-track",
  });
});
