import { expect, test } from "@playwright/test";

const CASES = [
  { name: "test_1.mp4", seekUs: 5_000_000 },
  { name: "test_3.mp4", seekUs: 30_000_000 },
] as const;

test.describe.configure({ mode: "serial" });

test("keeps audio-master sync and invalidates old audio for all fixtures", async ({
  page,
}) => {
  test.setTimeout(6 * 60_000);
  await page.goto("/sync-debug.html");

  for (const fixture of CASES) {
    await page.getByRole("button", { name: fixture.name, exact: true }).click();
    const panel = page.getByTestId("sync-panel");
    await expect(panel).toHaveAttribute("data-loaded-asset", fixture.name, {
      timeout: 90_000,
    });
    await expect(panel).toHaveAttribute("data-ready", "true", {
      timeout: 90_000,
    });
    await expect(
      page.locator("canvas[data-preview-canvas='pixi-v8']"),
    ).toBeVisible();

    await page.getByRole("button", { name: "播放", exact: true }).click();
    await expect(page.getByTestId("clock-source")).toContainText("audio", {
      timeout: 60_000,
    });
    const beforeSeek = await page.evaluate(() =>
      window.__TASK_9_SYNC__?.getAudioStats(),
    );
    expect(beforeSeek?.activeSources).toBeGreaterThan(0);

    await page
      .getByRole("slider", { name: "同步播放头" })
      .fill(String(fixture.seekUs));
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__TASK_9_SYNC__?.getAudioStats().generation ?? 0,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(beforeSeek?.generation ?? 0);
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__TASK_9_SYNC__?.getAudioStats().activeSources ?? 0,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(0);

    const afterSeek = await page.evaluate(() =>
      window.__TASK_9_SYNC__?.getAudioStats(),
    );
    expect(afterSeek?.activeSources).toBeGreaterThan(0);
    expect(afterSeek?.activeGenerations).toEqual([afterSeek?.generation]);
    expect(afterSeek?.activeGenerations).not.toContain(beforeSeek?.generation);
    expect(afterSeek?.stoppedSources).toBeGreaterThan(
      beforeSeek?.stoppedSources ?? 0,
    );

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const drift =
              window.__TASK_9_SYNC__?.getSnapshot().metrics.avDriftUs;
            return drift === undefined
              ? Number.POSITIVE_INFINITY
              : Math.abs(drift);
          }),
        { timeout: 60_000 },
      )
      .toBeLessThanOrEqual(100_000);

    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__TASK_9_SYNC__?.getAudioStats().activeSources,
        ),
      )
      .toBe(0);
    const pausedTime = await page.evaluate(
      () => window.__TASK_9_SYNC__?.getSnapshot().metrics.playheadUs ?? 0,
    );
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(
        () => window.__TASK_9_SYNC__?.getSnapshot().metrics.playheadUs ?? 0,
      ),
    ).toBe(pausedTime);
  }
});

test("exposes the explicit message-passing ring-buffer fallback", async ({
  page,
}) => {
  await page.goto("/sync-debug.html?forceMessage=1");
  await expect(page.getByTestId("ring-mode")).toHaveText("RING: MESSAGE");
  await expect(page.getByTestId("sync-panel")).toHaveAttribute(
    "data-loaded-asset",
    "test_1.mp4",
    { timeout: 90_000 },
  );
  await expect(page.getByTestId("sync-panel")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 90_000 },
  );
  expect(
    await page.evaluate(() => window.__TASK_9_SYNC__?.getRingStats().mode),
  ).toBe("message");
});
