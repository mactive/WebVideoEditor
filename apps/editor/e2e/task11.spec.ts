import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("exports a trimmed original-source project and restarts after cancellation", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const exportLogs: Array<Record<string, unknown>> = [];
  page.on("console", (message) => {
    try {
      const entry = JSON.parse(message.text()) as Record<string, unknown>;
      if (entry.marker === "[EXPORT]") {
        exportLogs.push(entry);
      }
    } catch {
      // Non-structured browser diagnostics are unrelated to this assertion.
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "总编辑器", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "能力", exact: true }).click();
  await expect(
    page.locator("[data-capability-id='h264Encode']"),
  ).toHaveAttribute("data-supported", "true", { timeout: 30_000 });
  await expect(
    page.locator("[data-capability-id='aacEncode']"),
  ).toHaveAttribute("data-supported", "true", { timeout: 30_000 });

  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const sourceItem = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(sourceItem).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await sourceItem.getByRole("button", { name: /添加到时间线/ }).click();
  const cancelProxy = sourceItem.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }

  await page.getByLabel("源入点（秒）").fill("1");
  await page.getByLabel("源出点（秒）").fill("3");
  await page.getByLabel("滤镜类型").selectOption("vintage");
  await page.getByLabel("滤镜强度").fill("1");
  await page.getByRole("button", { name: "添加标题" }).click();
  await page.getByLabel("标题文本").fill("TASK 11 EXPORT");
  await page.getByLabel("标题字号").fill("96");
  await page.getByLabel("标题结束时间").fill("2");

  const panel = page.getByTestId("export-panel");
  await expect(page.getByTestId("export-source")).toHaveText("source=original");
  await page.getByRole("button", { name: "开始导出" }).click();
  await expect(panel).toHaveAttribute("data-export-status", "running");
  await expect
    .poll(
      async () => Number(await panel.getAttribute("data-processed-frames")),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "取消导出" }).click();
  await expect(panel).toHaveAttribute("data-export-status", "cancelled");
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(
            "web-video-editor-exports-v1",
            { create: true },
          );
          const names: string[] = [];
          for await (const [name] of directory.entries()) {
            if (name.startsWith(".tmp-")) {
              names.push(name);
            }
          }
          return names;
        }),
      { timeout: 30_000 },
    )
    .toEqual([]);

  await page.getByRole("button", { name: "重新导出" }).click();
  await expect(panel).toHaveAttribute("data-export-status", "completed", {
    timeout: 3 * 60_000,
  });
  const metrics = await page.evaluate(() =>
    window.__TASK_11_EXPORT__?.getResult(),
  );
  expect(metrics).toMatchObject({
    audioCodec: "mp4a.40.2",
    durationUs: 2_000_000,
    frames: 60,
    height: 1080,
    mimeType: "video/mp4",
    source: "original",
    videoCodec: "avc1.640028",
    width: 1920,
  });
  expect(metrics?.bytes).toBeGreaterThan(10_000);
  expect(metrics?.audioFrames).toBeGreaterThan(90_000);

  const decoded = await page.evaluate(async () => {
    const file = await window.__TASK_11_EXPORT__?.getFile();
    if (!file) {
      throw new Error("Exported OPFS file is unavailable");
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(video.error ?? new Error("decode failed"));
    });
    video.currentTime = 0.5;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(video, 0, 0);
    const title = context.getImageData(650, 90, 620, 150).data;
    const center = context.getImageData(720, 300, 480, 500).data;
    let brightTitlePixels = 0;
    let red = 0;
    let blue = 0;
    for (let index = 0; index < title.length; index += 4) {
      if (
        (title[index] ?? 0) > 220 &&
        (title[index + 1] ?? 0) > 220 &&
        (title[index + 2] ?? 0) > 220
      ) {
        brightTitlePixels += 1;
      }
    }
    for (let index = 0; index < center.length; index += 4) {
      red += center[index] ?? 0;
      blue += center[index + 2] ?? 0;
    }
    URL.revokeObjectURL(url);
    return {
      brightTitlePixels,
      duration: video.duration,
      height: video.videoHeight,
      redBlueDelta: (red - blue) / (center.length / 4),
      width: video.videoWidth,
    };
  });
  expect(decoded).toMatchObject({ height: 1080, width: 1920 });
  expect(decoded.duration).toBeGreaterThanOrEqual(1.9);
  expect(decoded.duration).toBeLessThan(2.2);
  expect(decoded.brightTitlePixels).toBeGreaterThan(100);
  expect(decoded.redBlueDelta).toBeGreaterThan(2);
  console.info(
    `[TASK11_EVIDENCE] ${JSON.stringify({
      ...metrics,
      brightTitlePixels: decoded.brightTitlePixels,
      cancellationRestarted: true,
      decodedDurationSec: decoded.duration,
      redBlueDelta: decoded.redBlueDelta,
    })}`,
  );

  await page.evaluate(async () => {
    const file = await window.__TASK_11_EXPORT__?.getFile();
    const input = document.querySelector<HTMLInputElement>(
      ".media-panel__picker input[type=file]",
    );
    if (!file || !input) {
      throw new Error("Unable to re-import export");
    }
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const imported = page
    .locator(".media-panel__results > li")
    .filter({ hasText: metrics?.fileName ?? "export-" })
    .first();
  await expect(imported).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await expect(imported).toContainText("AVC");
  await expect(imported).toContainText("1920×1080");
  await expect(imported).toContainText("AAC");
  await expect(imported).toContainText("0:02");

  const completedLog = exportLogs.find(
    (entry) => entry.event === "completed",
  ) as
    | {
        input?: { source?: string };
        output?: { bytes?: number; source?: string };
      }
    | undefined;
  expect(completedLog?.input?.source).toBe("original");
  expect(completedLog?.output?.source).toBe("original");
  expect(completedLog?.output?.bytes).toBe(metrics?.bytes);

  await page.screenshot({
    fullPage: true,
    path: "test-results/task11-export.png",
  });
});
