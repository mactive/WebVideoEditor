import type { PreviewRuntimeSnapshot } from "@web-video-editor/preview-runtime";
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

type PreviewDiagnosticsWindow = Window & {
  __TASK_8_PREVIEW__?: {
    getSnapshot(): PreviewRuntimeSnapshot;
  };
};

type PixelEvidence = {
  blue: number;
  cyan: number;
  green: number;
  magenta: number;
  red: number;
  yellow: number;
};

async function fillAndBlur(page: Page, label: string, value: string) {
  const input = page.getByLabel(label);
  await input.fill(value);
  await input.blur();
}

async function importTrimmedTestOne(page: Page, durationSec: number) {
  await page.getByRole("button", { name: /test_1\.mp4/ }).click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: "test_1.mp4" })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  const cancelProxy = item.getByRole("button", { name: "取消代理" });
  if (await cancelProxy.isVisible()) {
    await cancelProxy.click();
  }
  await fillAndBlur(page, "源出点（秒）", String(durationSec));
  await fillAndBlur(page, "时间线总时长（秒）", String(durationSec));
  await page.getByRole("button", { name: "应用总长" }).click();

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
}

async function previewSnapshot(page: Page) {
  return page.evaluate(() =>
    (window as PreviewDiagnosticsWindow).__TASK_8_PREVIEW__!.getSnapshot(),
  );
}

async function seekPreview(page: Page, playheadUs: number) {
  await page
    .getByRole("slider", { name: "预览播放头" })
    .fill(String(playheadUs));
  await expect
    .poll(() =>
      previewSnapshot(page).then((snapshot) => snapshot.metrics.playheadUs),
    )
    .toBe(playheadUs);
}

async function projectJson(page: Page) {
  await page.getByRole("button", { name: "Project JSON", exact: true }).click();
  const value = await page.getByTestId("project-json").textContent();
  return JSON.parse(value ?? "{}") as {
    texts: Array<{
      backgroundColor: string;
      backgroundOpacity: number;
      color: string;
      endUs: number;
      fontFamily: string;
      fontSize: number;
      id: string;
      startUs: number;
      strokeColor: string;
      strokeWidth: number;
      text: string;
      trackId: string;
      y: number;
    }>;
    tracks: Array<{ id: string; kind: string; name: string; order: number }>;
  };
}

async function editSelectedText(
  page: Page,
  options: {
    backgroundColor: string;
    backgroundOpacity: string;
    color: string;
    end: string;
    fontFamily: string;
    fontSize: string;
    start: string;
    strokeColor: string;
    strokeWidth: string;
    text: string;
    y: string;
  },
) {
  await fillAndBlur(page, "标题文本", options.text);
  await fillAndBlur(page, "标题开始时间", options.start);
  await fillAndBlur(page, "标题结束时间", options.end);
  await fillAndBlur(page, "标题字号", options.fontSize);
  await fillAndBlur(page, "标题颜色", options.color);
  await fillAndBlur(page, "标题描边颜色", options.strokeColor);
  await fillAndBlur(page, "标题描边宽度", options.strokeWidth);
  await fillAndBlur(page, "标题背景底色", options.backgroundColor);
  await fillAndBlur(page, "标题背景透明度", options.backgroundOpacity);
  await fillAndBlur(page, "标题字体名称", options.fontFamily);
  await fillAndBlur(page, "位置 Y", options.y);
}

async function createStyledOverlappingTexts(page: Page) {
  await page.getByRole("button", { name: "添加标题" }).click();
  await editSelectedText(page, {
    backgroundColor: "#ff0000",
    backgroundOpacity: "0.85",
    color: "#00ff00",
    end: "2.4",
    fontFamily: "Arial, sans-serif",
    fontSize: "96",
    start: "0.8",
    strokeColor: "#ffff00",
    strokeWidth: "8",
    text: "TASK 5 GREEN",
    y: "0.18",
  });

  await page.getByRole("button", { name: "新增文字轨" }).click();
  await expect(
    page.getByRole("button", { exact: true, name: "T2 文字 2" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "添加标题" }).click();
  await editSelectedText(page, {
    backgroundColor: "#0000ff",
    backgroundOpacity: "0.85",
    color: "#00ffff",
    end: "2.2",
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    fontSize: "92",
    start: "1.0",
    strokeColor: "#ff00ff",
    strokeWidth: "8",
    text: "TASK 5 CYAN",
    y: "0.32",
  });
}

async function previewPixelEvidence(page: Page) {
  return page
    .locator("canvas[data-preview-canvas='pixi-v8']")
    .evaluate((canvas) => {
      const countEvidence = (
        data: Uint8ClampedArray,
        width: number,
        height: number,
      ) => {
        const evidence: PixelEvidence = {
          blue: 0,
          cyan: 0,
          green: 0,
          magenta: 0,
          red: 0,
          yellow: 0,
        };
        const maxY = Math.floor(height * 0.5);
        for (let y = 0; y < maxY; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const red = data[offset] ?? 0;
            const green = data[offset + 1] ?? 0;
            const blue = data[offset + 2] ?? 0;
            if (red > 125 && green < 115 && blue < 115) {
              evidence.red += 1;
            }
            if (blue > 125 && red < 115 && green < 135) {
              evidence.blue += 1;
            }
            if (green > 135 && red < 125 && blue < 135) {
              evidence.green += 1;
            }
            if (green > 125 && blue > 125 && red < 120) {
              evidence.cyan += 1;
            }
            if (red > 135 && green > 125 && blue < 130) {
              evidence.yellow += 1;
            }
            if (red > 125 && blue > 125 && green < 125) {
              evidence.magenta += 1;
            }
          }
        }
        return evidence;
      };
      const source = canvas as HTMLCanvasElement;
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("Preview pixel context unavailable");
      }
      context.drawImage(source, 0, 0);
      return countEvidence(
        context.getImageData(0, 0, copy.width, copy.height).data,
        copy.width,
        copy.height,
      );
    });
}

function expectStyledTextPixels(active: PixelEvidence, outside: PixelEvidence) {
  expect(active.red).toBeGreaterThan(outside.red + 500);
  expect(active.blue).toBeGreaterThan(outside.blue + 500);
  expect(active.green).toBeGreaterThan(outside.green + 60);
  expect(active.cyan).toBeGreaterThan(outside.cyan + 60);
  expect(active.yellow).toBeGreaterThan(outside.yellow + 40);
  expect(active.magenta).toBeGreaterThan(outside.magenta + 40);
}

test("adds overlapping styled text to separate text tracks and proves preview pixels", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  await page.goto("/");
  await importTrimmedTestOne(page, 2.8);
  await createStyledOverlappingTexts(page);

  let project = await projectJson(page);
  const textTracks = project.tracks
    .filter((track) => track.kind === "text")
    .sort((left, right) => left.order - right.order);
  expect(textTracks.map((track) => track.id)).toEqual([
    "text-track",
    "text-track-2",
  ]);
  expect(project.texts).toHaveLength(2);
  expect(project.texts[0]).toMatchObject({
    backgroundColor: "#ff0000",
    backgroundOpacity: 0.85,
    color: "#00ff00",
    endUs: 2_400_000,
    fontFamily: "Arial, sans-serif",
    fontSize: 96,
    startUs: 800_000,
    strokeColor: "#ffff00",
    strokeWidth: 8,
    text: "TASK 5 GREEN",
    trackId: "text-track",
    y: 0.18,
  });
  expect(project.texts[1]).toMatchObject({
    backgroundColor: "#0000ff",
    backgroundOpacity: 0.85,
    color: "#00ffff",
    endUs: 2_200_000,
    fontFamily: '"SFMono-Regular", Consolas, monospace',
    fontSize: 92,
    startUs: 1_000_000,
    strokeColor: "#ff00ff",
    strokeWidth: 8,
    text: "TASK 5 CYAN",
    trackId: "text-track-2",
    y: 0.32,
  });

  await fillAndBlur(page, "标题文本", "TASK 5 REDO");
  project = await projectJson(page);
  expect(project.texts[1]?.text).toBe("TASK 5 REDO");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  project = await projectJson(page);
  expect(project.texts[1]?.text).toBe("TASK 5 CYAN");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  project = await projectJson(page);
  expect(project.texts[1]?.text).toBe("TASK 5 REDO");

  await seekPreview(page, 400_000);
  const outside = await previewPixelEvidence(page);
  await seekPreview(page, 1_500_000);
  const active = await previewPixelEvidence(page);
  console.info(
    `[TASK5_PREVIEW_TEXT_PIXELS] ${JSON.stringify({ active, outside })}`,
  );
  expectStyledTextPixels(active, outside);
});

test("exports styled text only inside its time range with stroke and background pixels", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await importTrimmedTestOne(page, 2.8);
  await createStyledOverlappingTexts(page);

  await page.getByRole("button", { name: "开始导出" }).click();
  await expect(page.getByTestId("export-panel")).toHaveAttribute(
    "data-export-status",
    "completed",
    { timeout: 3 * 60_000 },
  );

  const evidence = await page.evaluate(async () => {
    const countEvidence = (
      data: Uint8ClampedArray,
      width: number,
      height: number,
    ) => {
      const evidence: PixelEvidence = {
        blue: 0,
        cyan: 0,
        green: 0,
        magenta: 0,
        red: 0,
        yellow: 0,
      };
      const maxY = Math.floor(height * 0.5);
      for (let y = 0; y < maxY; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          const red = data[offset] ?? 0;
          const green = data[offset + 1] ?? 0;
          const blue = data[offset + 2] ?? 0;
          if (red > 125 && green < 115 && blue < 115) {
            evidence.red += 1;
          }
          if (blue > 125 && red < 115 && green < 135) {
            evidence.blue += 1;
          }
          if (green > 135 && red < 125 && blue < 135) {
            evidence.green += 1;
          }
          if (green > 125 && blue > 125 && red < 120) {
            evidence.cyan += 1;
          }
          if (red > 135 && green > 125 && blue < 130) {
            evidence.yellow += 1;
          }
          if (red > 125 && blue > 125 && green < 125) {
            evidence.magenta += 1;
          }
        }
      }
      return evidence;
    };
    const diagnostics = window.__TASK_11_EXPORT__;
    const file = await diagnostics?.getFile();
    if (!file) {
      throw new Error("Task 5 export file is unavailable");
    }
    const url = URL.createObjectURL(file);
    try {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = url;
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () =>
          reject(video.error ?? new Error("Unable to load exported video"));
      });
      const seek = async (time: number) => {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error(`Export seek timed out at ${time}s`)),
            20_000,
          );
          video.onseeked = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          video.currentTime = time;
        });
      };
      const capture = async (time: number) => {
        await seek(time);
        const width = 960;
        const height = 540;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!context) {
          throw new Error("Export pixel context unavailable");
        }
        context.drawImage(video, 0, 0, width, height);
        return countEvidence(
          context.getImageData(0, 0, width, height).data,
          width,
          height,
        );
      };
      return {
        active: await capture(1.5),
        after: await capture(2.55),
        before: await capture(0.45),
        decoded: {
          duration: video.duration,
          height: video.videoHeight,
          readyState: video.readyState,
          width: video.videoWidth,
        },
        result: diagnostics?.getResult(),
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  });

  expect(evidence.result).toMatchObject({
    height: 1080,
    source: "original",
    width: 1920,
  });
  expect(evidence.result?.durationUs).toBeGreaterThanOrEqual(2_800_000);
  expect(evidence.result?.frames).toBeGreaterThanOrEqual(84);
  expect(evidence.decoded).toMatchObject({
    height: 1080,
    width: 1920,
  });
  expect(evidence.decoded.readyState).toBeGreaterThanOrEqual(1);
  console.info(`[TASK5_EXPORT_TEXT_PIXELS] ${JSON.stringify(evidence)}`);
  expectStyledTextPixels(evidence.active, evidence.before);
  expectStyledTextPixels(evidence.active, evidence.after);
});
