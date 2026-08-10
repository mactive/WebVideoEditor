import { expect, test, type Page } from "@playwright/test";

async function importTestOne(page: Page) {
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  const cancelProxy = item.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }
  return item;
}

async function fill(page: Page, label: string, value: string) {
  const input = page.getByLabel(label);
  await input.fill(value);
  await input.blur();
}

test("Task 18 exports and reimports ordered transformed clips with title, filter, and audio", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  const item = await importTestOne(page);

  await item.getByRole("button", { name: /添加到时间线/ }).click();
  await fill(page, "源入点（秒）", "0.5");
  await fill(page, "源出点（秒）", "1.5");

  await item.getByRole("button", { name: /添加到时间线/ }).click();
  await fill(page, "源入点（秒）", "12");
  await fill(page, "源出点（秒）", "13");
  await fill(page, "片段位置 X", "0.68");
  await fill(page, "片段位置 Y", "0.62");
  await fill(page, "片段缩放", "0.58");
  await fill(page, "片段旋转", "18");
  await page.getByLabel("滤镜类型").selectOption("grayscale");
  await fill(page, "滤镜强度", "1");

  await page.getByRole("button", { name: "添加标题" }).click();
  await fill(page, "标题文本", "TASK 18");
  await fill(page, "标题字号", "92");
  await fill(page, "标题颜色", "#ff2d55");
  await fill(page, "标题结束时间", "0.9");

  await page.getByRole("button", { name: "Project JSON", exact: true }).click();
  const project = JSON.parse(
    (await page.getByTestId("project-json").textContent()) ?? "{}",
  ) as {
    clips: Array<{
      effects: Array<{ amount: number; kind: string }>;
      sourceEndUs: number;
      sourceStartUs: number;
      timelineStartUs: number;
      transform?: {
        rotationDeg: number;
        scale: number;
        x: number;
        y: number;
      };
    }>;
    texts: Array<{ color: string; endUs: number; text: string }>;
  };
  expect(project.clips).toHaveLength(2);
  expect(project.clips[0]).toMatchObject({
    sourceEndUs: 1_500_000,
    sourceStartUs: 500_000,
    timelineStartUs: 0,
  });
  expect(project.clips[1]).toMatchObject({
    effects: [{ amount: 1, kind: "grayscale" }],
    sourceEndUs: 13_000_000,
    sourceStartUs: 12_000_000,
    timelineStartUs: 1_000_000,
    transform: {
      rotationDeg: 18,
      scale: 0.58,
      x: 0.68,
      y: 0.62,
    },
  });
  expect(project.texts[0]).toMatchObject({
    color: "#ff2d55",
    endUs: 900_000,
    text: "TASK 18",
  });

  await page.getByRole("button", { name: "开始导出" }).click();
  await expect(page.getByTestId("export-panel")).toHaveAttribute(
    "data-export-status",
    "completed",
    { timeout: 3 * 60_000 },
  );

  const mediaEvidence = await page.evaluate(async () => {
    const diagnostics = window.__TASK_11_EXPORT__;
    const file = await diagnostics?.getFile();
    const inspection = await diagnostics?.inspectFile();
    if (!file || !inspection) {
      throw new Error("Task 18 export evidence is unavailable");
    }

    const createVideo = async (url: string) => {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () =>
          reject(video.error ?? new Error(`Unable to load ${url}`));
      });
      return video;
    };
    const seek = async (video: HTMLVideoElement, time: number) => {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error(`Seek timed out at ${time}s`)),
          20_000,
        );
        video.onseeked = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        video.currentTime = time;
      });
    };
    const width = 480;
    const height = 270;
    const read = (canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Pixel read context unavailable");
      }
      return Array.from(context.getImageData(0, 0, width, height).data);
    };
    const capture = async (video: HTMLVideoElement, time: number) => {
      await seek(video, time);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Pixel capture context unavailable");
      }
      context.drawImage(video, 0, 0, width, height);
      return read(canvas);
    };
    const expected = async (
      video: HTMLVideoElement,
      sourceTime: number,
      transform: {
        grayscale: boolean;
        rotationDeg: number;
        scale: number;
        x: number;
        y: number;
      },
    ) => {
      await seek(video, sourceTime);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Expected frame context unavailable");
      }
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      context.save();
      context.filter = transform.grayscale ? "grayscale(1)" : "none";
      context.translate(transform.x * width, transform.y * height);
      context.rotate((transform.rotationDeg * Math.PI) / 180);
      context.scale(transform.scale, transform.scale);
      const fit = Math.min(
        width / video.videoWidth,
        height / video.videoHeight,
      );
      const drawWidth = video.videoWidth * fit;
      const drawHeight = video.videoHeight * fit;
      context.drawImage(
        video,
        -drawWidth / 2,
        -drawHeight / 2,
        drawWidth,
        drawHeight,
      );
      context.restore();
      return read(canvas);
    };
    const difference = (left: number[], right: number[], minimumY = 0) => {
      let total = 0;
      let count = 0;
      for (let y = minimumY; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          total +=
            Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
            Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
            Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
          count += 3;
        }
      }
      return total / count;
    };
    const chroma = (pixels: number[]) => {
      let total = 0;
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const channels = [
          pixels[offset] ?? 0,
          pixels[offset + 1] ?? 0,
          pixels[offset + 2] ?? 0,
        ];
        if (Math.max(...channels) > 15) {
          total += Math.max(...channels) - Math.min(...channels);
          count += 1;
        }
      }
      return count === 0 ? 0 : total / count;
    };
    const redTitlePixels = (pixels: number[]) => {
      let count = 0;
      for (let y = 0; y < height * 0.35; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const red = pixels[offset] ?? 0;
          const green = pixels[offset + 1] ?? 0;
          const blue = pixels[offset + 2] ?? 0;
          if (red > 150 && red > green * 1.35 && red > blue * 1.2) {
            count += 1;
          }
        }
      }
      return count;
    };

    const exportedUrl = URL.createObjectURL(file);
    const exported = await createVideo(exportedUrl);
    const original = await createVideo(
      new URL("/test_assets/test_1.mp4", location.href).href,
    );
    const before = await capture(exported, 0.8);
    const after = await capture(exported, 1.1);
    const defaultTransform = {
      grayscale: false,
      rotationDeg: 0,
      scale: 1,
      x: 0.5,
      y: 0.5,
    };
    const transformed = {
      grayscale: true,
      rotationDeg: 18,
      scale: 0.58,
      x: 0.68,
      y: 0.62,
    };
    const beforeCorrect = await expected(original, 1.3, defaultTransform);
    const beforeWrong = await expected(original, 12.1, defaultTransform);
    const afterCorrect = await expected(original, 12.1, transformed);
    const afterWrong = await expected(original, 1.3, transformed);
    const afterNoTransform = await expected(original, 12.1, {
      ...defaultTransform,
      grayscale: true,
    });
    const afterNoRotation = await expected(original, 12.1, {
      ...transformed,
      rotationDeg: 0,
    });
    const pixels = {
      afterChroma: chroma(after),
      afterCorrectDiff: difference(after, afterCorrect),
      afterNoRotationDiff: difference(after, afterNoRotation),
      afterNoTransformDiff: difference(after, afterNoTransform),
      afterWrongSourceDiff: difference(after, afterWrong),
      beforeChroma: chroma(before),
      beforeCorrectDiff: difference(before, beforeCorrect, 120),
      beforeWrongSourceDiff: difference(before, beforeWrong, 120),
      boundaryDiff: difference(before, after),
      redTitlePixels: redTitlePixels(before),
    };
    URL.revokeObjectURL(exportedUrl);

    const logs =
      window.__TASK_14_RUNTIME__
        ?.getLogs()
        .filter(
          (entry) =>
            entry.marker === "[EXPORT]" &&
            entry.scope === "export-worker" &&
            (entry.event === "started" || entry.event === "completed"),
        ) ?? [];
    return {
      decoded: {
        duration: exported.duration,
        height: exported.videoHeight,
        readyState: exported.readyState,
        width: exported.videoWidth,
      },
      inspection,
      logs,
      pixels,
      result: diagnostics?.getResult(),
    };
  });

  expect(mediaEvidence.result).toMatchObject({
    audioCodec: "mp4a.40.2",
    durationUs: 2_000_000,
    frames: 60,
    height: 1080,
    source: "original",
    width: 1920,
  });
  expect(mediaEvidence.decoded).toMatchObject({
    height: 1080,
    width: 1920,
  });
  expect(mediaEvidence.decoded.duration).toBeGreaterThan(1.9);
  expect(mediaEvidence.decoded.duration).toBeLessThan(2.15);
  expect(mediaEvidence.decoded.readyState).toBeGreaterThanOrEqual(1);

  const probe = mediaEvidence.inspection.probe;
  const videoTrack = probe.videoTracks.find(
    (track) => track.trackId === probe.primaryVideoTrackId,
  );
  const audioTrack = probe.audioTracks.find(
    (track) => track.trackId === probe.primaryAudioTrackId,
  );
  expect(probe.container.mimeType).toMatch(/^video\/mp4(?:;|$)/);
  expect(probe.source.kind).toBe("blob");
  expect(probe.durationSec).toBeGreaterThan(1.9);
  expect(probe.durationSec).toBeLessThan(2.15);
  expect(videoTrack).toMatchObject({
    codec: "avc",
    decodable: true,
    displayHeight: 1080,
    displayWidth: 1920,
  });
  expect(audioTrack).toMatchObject({
    channels: 2,
    codec: "aac",
    decodable: true,
    sampleRate: 48_000,
  });
  expect(mediaEvidence.inspection.audio).toMatchObject({
    timestampsMonotonic: true,
  });
  expect(mediaEvidence.inspection.audio?.packetCount).toBeGreaterThan(80);
  expect(
    mediaEvidence.inspection.audio?.firstTimestampUs,
  ).toBeGreaterThanOrEqual(0);
  expect(mediaEvidence.inspection.audio?.firstTimestampUs).toBeLessThan(30_000);
  expect(
    mediaEvidence.inspection.audio?.lastEndTimestampUs,
  ).toBeGreaterThanOrEqual(1_950_000);

  const pixels = mediaEvidence.pixels;
  console.info(`[TASK18_PIXEL_METRICS] ${JSON.stringify(pixels)}`);
  expect(pixels.boundaryDiff).toBeGreaterThan(5);
  expect(pixels.beforeCorrectDiff).toBeLessThan(
    pixels.beforeWrongSourceDiff * 0.8,
  );
  expect(pixels.afterCorrectDiff).toBeLessThan(
    pixels.afterWrongSourceDiff * 0.8,
  );
  expect(pixels.afterCorrectDiff).toBeLessThan(
    pixels.afterNoTransformDiff * 0.8,
  );
  expect(pixels.afterCorrectDiff).toBeLessThan(
    pixels.afterNoRotationDiff * 0.9,
  );
  expect(pixels.afterChroma).toBeLessThan(4);
  expect(pixels.beforeChroma).toBeGreaterThan(pixels.afterChroma + 3);
  expect(pixels.redTitlePixels).toBeGreaterThan(100);

  expect(mediaEvidence.logs).toHaveLength(2);
  expect(mediaEvidence.logs[0]?.input).toMatchObject({ source: "original" });
  expect(mediaEvidence.logs[0]?.output).toMatchObject({
    mediaSource: "original",
  });
  expect(mediaEvidence.logs[1]?.input).toMatchObject({ source: "original" });
  expect(pageErrors).toEqual([]);

  console.info(
    `[TASK18_EXPORT_EVIDENCE] ${JSON.stringify({
      audio: mediaEvidence.inspection.audio,
      decoded: mediaEvidence.decoded,
      pixels,
      probe: {
        audio: audioTrack,
        durationSec: probe.durationSec,
        video: videoTrack,
      },
      result: mediaEvidence.result,
    })}`,
  );
});
