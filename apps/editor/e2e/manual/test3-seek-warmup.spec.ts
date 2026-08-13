import { expect, test, type Page } from "@playwright/test";
import type { PreviewRuntimeSnapshot } from "@web-video-editor/preview-runtime";

declare global {
  interface Window {
    __TASK_8_PREVIEW__?: {
      getSnapshot(): PreviewRuntimeSnapshot;
      seek(playheadUs: number): void;
    };
  }
}

type RuntimeSnapshotEvidence = {
  buffering: boolean;
  decoder: PreviewRuntimeSnapshot["metrics"]["codecQueues"]["videoDecoder"]["applicationQueue"];
  droppedFrames: number;
  fps: number;
  playheadUs: number;
  presentedFrames: number;
  presentedPlayheadUs: number;
  staleFrames: number;
  timestampDrops: number;
};

type WarmupEvidence = {
  after: RuntimeSnapshotEvidence;
  before: RuntimeSnapshotEvidence;
  droppedDelta: number;
  label: string;
  playbackFirstFramesMs: number;
  seekSettleMs: number;
  sourceMode: string;
  staleDelta: number;
  targetUs: number;
};

function snapshotEvidence(
  snapshot: PreviewRuntimeSnapshot,
): RuntimeSnapshotEvidence {
  return {
    buffering: snapshot.buffering,
    decoder: snapshot.metrics.codecQueues.videoDecoder.applicationQueue,
    droppedFrames: snapshot.metrics.droppedFrames,
    fps: snapshot.metrics.fps,
    playheadUs: snapshot.metrics.playheadUs,
    presentedFrames: snapshot.metrics.presentedFrames,
    presentedPlayheadUs: snapshot.metrics.presentedPlayheadUs,
    staleFrames: snapshot.metrics.staleFrames,
    timestampDrops: snapshot.metrics.timestampDrops,
  };
}

async function runtimeSnapshot(page: Page): Promise<PreviewRuntimeSnapshot> {
  return page.evaluate(() => {
    const snapshot = window.__TASK_8_PREVIEW__?.getSnapshot();
    if (!snapshot) {
      throw new Error("Preview diagnostics are unavailable");
    }
    return snapshot;
  });
}

async function importTestThreeAndAdd(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "清理代理缓存" }).click();
  await page.getByRole("button", { name: /test_3\.mp4/ }).click();

  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_3.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
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

async function rapidSeek(page: Page, seekValuesUs: readonly number[]) {
  for (const value of seekValuesUs) {
    await page.evaluate((playheadUs) => {
      window.__TASK_8_PREVIEW__?.seek(playheadUs);
    }, value);
    await page.waitForTimeout(40);
  }
}

async function measureSeekThenPlayback(
  page: Page,
  label: string,
  seekValuesUs: readonly number[],
): Promise<WarmupEvidence> {
  const before = snapshotEvidence(await runtimeSnapshot(page));
  const targetUs = seekValuesUs[seekValuesUs.length - 1]!;
  const seekStartedAt = Date.now();
  await rapidSeek(page, seekValuesUs);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__TASK_8_PREVIEW__?.getSnapshot().metrics
              .presentedPlayheadUs ?? -1,
        ),
      { timeout: 60_000 },
    )
    .toBe(targetUs);
  const seekSettleMs = Date.now() - seekStartedAt;

  const framesBeforePlay = (await runtimeSnapshot(page)).metrics
    .presentedFrames;
  const playbackStartedAt = Date.now();
  await page.getByRole("button", { name: "播放", exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          (minimumFrames) =>
            (window.__TASK_8_PREVIEW__?.getSnapshot().metrics.presentedFrames ??
              0) >
            minimumFrames + 2,
          framesBeforePlay,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  const playbackFirstFramesMs = Date.now() - playbackStartedAt;
  await page.getByRole("button", { name: "暂停", exact: true }).click();

  const after = snapshotEvidence(await runtimeSnapshot(page));
  const sourceMode =
    (await page.getByTestId("preview-source-mode").textContent()) ?? "";

  return {
    after,
    before,
    droppedDelta: after.droppedFrames - before.droppedFrames,
    label,
    playbackFirstFramesMs,
    seekSettleMs,
    sourceMode,
    staleDelta: after.staleFrames - before.staleFrames,
    targetUs,
  };
}

test("manual test_3 rapid seek warm-up evidence", async ({
  page,
}, testInfo) => {
  test.setTimeout(8 * 60_000);
  const { item } = await importTestThreeAndAdd(page);

  const initial = await measureSeekThenPlayback(
    page,
    "initial",
    [5_000_000, 30_000_000, 8_000_000, 60_000_000, 12_000_000],
  );

  await expect(item.locator(".proxy-progress")).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 7 * 60_000 },
  );
  await expect(page.getByTestId("preview-source-mode")).toContainText("proxy", {
    timeout: 60_000,
  });

  const proxyReady = await measureSeekThenPlayback(
    page,
    "proxy-ready",
    [15_000_000, 70_000_000, 20_000_000, 90_000_000, 25_000_000],
  );

  const evidence = {
    initial,
    proxyReady,
  };
  await testInfo.attach("test3-seek-warmup-evidence", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  console.info(`[TEST3_SEEK_WARMUP] ${JSON.stringify(evidence)}`);

  expect(proxyReady.sourceMode).toContain("proxy");
  expect(proxyReady.after.decoder.active).toBe(0);
  expect(proxyReady.after.decoder.queued).toBe(0);
});
