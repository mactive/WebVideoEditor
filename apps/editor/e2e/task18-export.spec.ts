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
  await page.getByTestId("structured-log-toggle").click();
  await expect(page.getByTestId("structured-log-toggle")).toHaveText(
    "日志开启",
  );
  const item = await importTestOne(page);

  await item.getByRole("button", { name: /添加到时间线/ }).click();
  await fill(page, "源入点（秒）", "0.5");
  await fill(page, "源出点（秒）", "2.5");

  await item.getByRole("button", { name: "添加音频到时间线" }).click();
  await fill(page, "时间线起点（秒）", "0.25");
  await fill(page, "源入点（秒）", "0.5");
  await fill(page, "源出点（秒）", "2.5");

  await page.getByRole("button", { name: "新增视频轨" }).click();
  await expect(
    page.getByRole("button", { exact: true, name: "V2 视频 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  await fill(page, "源入点（秒）", "12");
  await fill(page, "源出点（秒）", "14");
  await fill(page, "片段位置 X", "0.68");
  await fill(page, "片段位置 Y", "0.62");
  await fill(page, "片段缩放", "0.58");
  await fill(page, "片段旋转", "18");
  await page.getByLabel("滤镜类型").selectOption("grayscale");
  await fill(page, "滤镜强度", "1");

  await page.getByRole("button", { name: "新增音频轨" }).click();
  await expect(
    page.getByRole("button", { exact: true, name: "A2 音频 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await item.getByRole("button", { name: "添加音频到时间线" }).click();
  await fill(page, "时间线起点（秒）", "0.6");
  await fill(page, "源入点（秒）", "12");
  await fill(page, "源出点（秒）", "14");

  await page.getByRole("button", { name: "添加标题" }).click();
  await fill(page, "标题文本", "TASK 18");
  await fill(page, "标题字号", "92");
  await fill(page, "标题颜色", "#ff2d55");
  await fill(page, "标题结束时间", "0.9");
  await fill(page, "时间线总时长（秒）", "2.6");
  await page.getByRole("button", { name: "应用总长" }).click();

  await page.getByRole("button", { name: "Project JSON", exact: true }).click();
  const project = JSON.parse(
    (await page.getByTestId("project-json").textContent()) ?? "{}",
  ) as {
    clips: Array<{
      effects: Array<{ amount: number; kind: string }>;
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
    texts: Array<{ color: string; endUs: number; text: string }>;
    tracks: Array<{ id: string; kind: string; order: number }>;
  };
  expect(project.clips).toHaveLength(4);
  expect(
    project.tracks
      .filter((track) => track.kind === "video")
      .sort((left, right) => left.order - right.order)
      .map((track) => track.id),
  ).toEqual(["video-track", "video-track-2"]);
  expect(
    project.tracks
      .filter((track) => track.kind === "audio")
      .sort((left, right) => left.order - right.order)
      .map((track) => track.id),
  ).toEqual(["audio-track", "audio-track-2"]);
  const clipByTrack = new Map(
    project.clips.map((clip) => [clip.trackId, clip]),
  );
  expect(clipByTrack.get("video-track")).toMatchObject({
    sourceEndUs: 2_500_000,
    sourceStartUs: 500_000,
    timelineStartUs: 0,
    trackId: "video-track",
  });
  expect(clipByTrack.get("video-track-2")).toMatchObject({
    effects: [{ amount: 1, kind: "grayscale" }],
    sourceEndUs: 14_000_000,
    sourceStartUs: 12_000_000,
    timelineStartUs: 0,
    trackId: "video-track-2",
    transform: {
      rotationDeg: 18,
      scale: 0.58,
      x: 0.68,
      y: 0.62,
    },
  });
  expect(clipByTrack.get("audio-track")).toMatchObject({
    sourceEndUs: 2_500_000,
    sourceStartUs: 500_000,
    timelineStartUs: 250_000,
    trackId: "audio-track",
  });
  expect(clipByTrack.get("audio-track-2")).toMatchObject({
    sourceEndUs: 14_000_000,
    sourceStartUs: 12_000_000,
    timelineStartUs: 600_000,
    trackId: "audio-track-2",
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
    type TransformSpec = {
      grayscale: boolean;
      rotationDeg: number;
      scale: number;
      x: number;
      y: number;
    };
    type LayerSpec = {
      sourceTime: number;
      transform: TransformSpec;
    };
    const drawLayer = async (
      context: CanvasRenderingContext2D,
      video: HTMLVideoElement,
      layer: LayerSpec,
    ) => {
      await seek(video, layer.sourceTime);
      const transform = layer.transform;
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
      context.filter = "none";
      context.setTransform(1, 0, 0, 1, 0, 0);
    };
    const expected = async (
      video: HTMLVideoElement,
      layers: readonly LayerSpec[],
    ) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Expected frame context unavailable");
      }
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      for (const layer of layers) {
        await drawLayer(context, video, layer);
      }
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
    const brightness = (pixels: number[], offset: number) =>
      (pixels[offset] ?? 0) +
      (pixels[offset + 1] ?? 0) +
      (pixels[offset + 2] ?? 0);
    const maskedDifference = (
      left: number[],
      right: number[],
      include: number[],
      exclude?: number[],
    ) => {
      let total = 0;
      let count = 0;
      for (let offset = 0; offset < left.length; offset += 4) {
        if (
          brightness(include, offset) <= 30 ||
          (exclude && brightness(exclude, offset) > 30)
        ) {
          continue;
        }
        total +=
          Math.abs((left[offset] ?? 0) - (right[offset] ?? 0)) +
          Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0)) +
          Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0));
        count += 3;
      }
      return count === 0 ? 255 : total / count;
    };
    const maskPixelCount = (include: number[], exclude?: number[]) => {
      let count = 0;
      for (let offset = 0; offset < include.length; offset += 4) {
        if (
          brightness(include, offset) > 30 &&
          (!exclude || brightness(exclude, offset) <= 30)
        ) {
          count += 1;
        }
      }
      return count;
    };
    const chroma = (
      pixels: number[],
      include?: number[],
      exclude?: number[],
    ) => {
      let total = 0;
      let count = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          include &&
          (brightness(include, offset) <= 30 ||
            (exclude && brightness(exclude, offset) > 30))
        ) {
          continue;
        }
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
    const beforeBase = {
      sourceTime: 1.3,
      transform: defaultTransform,
    };
    const beforeOverlay = {
      sourceTime: 12.8,
      transform: transformed,
    };
    const afterBase = {
      sourceTime: 1.6,
      transform: defaultTransform,
    };
    const afterOverlay = {
      sourceTime: 13.1,
      transform: transformed,
    };
    const beforeBaseLayer = await expected(original, [beforeBase]);
    const beforeOverlayLayer = await expected(original, [beforeOverlay]);
    const beforeCombined = await expected(original, [
      beforeBase,
      beforeOverlay,
    ]);
    const afterBaseLayer = await expected(original, [afterBase]);
    const afterOverlayLayer = await expected(original, [afterOverlay]);
    const afterCombined = await expected(original, [afterBase, afterOverlay]);
    const afterNoTransform = await expected(original, [
      afterBase,
      {
        sourceTime: 13.1,
        transform: {
          ...defaultTransform,
          grayscale: true,
        },
      },
    ]);
    const afterNoRotation = await expected(original, [
      afterBase,
      {
        sourceTime: 13.1,
        transform: {
          ...transformed,
          rotationDeg: 0,
        },
      },
    ]);
    const pixels = {
      afterBaseOnlyDiff: difference(after, afterBaseLayer),
      afterCombinedDiff: difference(after, afterCombined),
      afterNoRotationDiff: difference(after, afterNoRotation),
      afterNoTransformDiff: difference(after, afterNoTransform),
      afterOverlayOnlyDiff: difference(after, afterOverlayLayer),
      baseOutsideOverlayChroma: chroma(
        after,
        afterBaseLayer,
        afterOverlayLayer,
      ),
      baseOutsideOverlayDiff: maskedDifference(
        after,
        afterBaseLayer,
        afterBaseLayer,
        afterOverlayLayer,
      ),
      baseOutsideOverlayPixelCount: maskPixelCount(
        afterBaseLayer,
        afterOverlayLayer,
      ),
      baseOutsideOverlayWrongDiff: maskedDifference(
        after,
        afterOverlayLayer,
        afterBaseLayer,
        afterOverlayLayer,
      ),
      beforeBaseOnlyDiff: difference(before, beforeBaseLayer, 120),
      beforeCombinedDiff: difference(before, beforeCombined, 120),
      beforeOverlayOnlyDiff: difference(before, beforeOverlayLayer, 120),
      boundaryDiff: difference(before, after),
      overlayPixelCount: maskPixelCount(afterOverlayLayer),
      overlayRegionBaseDiff: maskedDifference(
        after,
        afterBaseLayer,
        afterOverlayLayer,
      ),
      overlayRegionChroma: chroma(after, afterOverlayLayer),
      overlayRegionDiff: maskedDifference(
        after,
        afterOverlayLayer,
        afterOverlayLayer,
      ),
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
    durationUs: 2_600_000,
    frames: 78,
    height: 1080,
    source: "original",
    width: 1920,
  });
  expect(mediaEvidence.decoded).toMatchObject({
    height: 1080,
    width: 1920,
  });
  expect(mediaEvidence.decoded.duration).toBeGreaterThan(1.9);
  expect(mediaEvidence.decoded.duration).toBeLessThan(2.85);
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
  expect(probe.durationSec).toBeGreaterThan(2.55);
  expect(probe.durationSec).toBeLessThan(2.85);
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
  expect(mediaEvidence.result.audioFrames).toBeGreaterThanOrEqual(124_000);
  expect(mediaEvidence.result.audioFrames).toBeLessThan(126_000);
  expect(mediaEvidence.inspection.audio?.packetCount).toBeGreaterThan(100);
  expect(
    mediaEvidence.inspection.audio?.firstTimestampUs,
  ).toBeGreaterThanOrEqual(0);
  expect(mediaEvidence.inspection.audio?.firstTimestampUs).toBeLessThan(30_000);
  expect(
    mediaEvidence.inspection.audio?.lastEndTimestampUs,
  ).toBeGreaterThanOrEqual(2_550_000);

  const pixels = mediaEvidence.pixels;
  console.info(`[TASK18_PIXEL_METRICS] ${JSON.stringify(pixels)}`);
  expect(pixels.boundaryDiff).toBeGreaterThan(5);
  expect(pixels.beforeCombinedDiff).toBeLessThan(
    pixels.beforeBaseOnlyDiff * 0.9,
  );
  expect(pixels.beforeCombinedDiff).toBeLessThan(
    pixels.beforeOverlayOnlyDiff * 0.9,
  );
  expect(pixels.afterCombinedDiff).toBeLessThan(pixels.afterBaseOnlyDiff * 0.9);
  expect(pixels.afterCombinedDiff).toBeLessThan(
    pixels.afterOverlayOnlyDiff * 0.9,
  );
  expect(pixels.afterCombinedDiff).toBeLessThan(
    pixels.afterNoTransformDiff * 0.8,
  );
  expect(pixels.afterCombinedDiff).toBeLessThan(
    pixels.afterNoRotationDiff * 0.9,
  );
  expect(pixels.overlayPixelCount).toBeGreaterThan(2_000);
  expect(pixels.baseOutsideOverlayPixelCount).toBeGreaterThan(5_000);
  expect(pixels.overlayRegionDiff).toBeLessThan(
    pixels.overlayRegionBaseDiff * 0.75,
  );
  expect(pixels.baseOutsideOverlayDiff).toBeLessThan(
    pixels.baseOutsideOverlayWrongDiff * 0.75,
  );
  expect(pixels.overlayRegionChroma).toBeLessThan(
    pixels.baseOutsideOverlayChroma,
  );
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
