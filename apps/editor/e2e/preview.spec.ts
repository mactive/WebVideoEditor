import { expect, test } from "@playwright/test";

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
