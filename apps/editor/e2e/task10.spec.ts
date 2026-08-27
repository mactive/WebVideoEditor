import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function importAndAdd(
  page: import("@playwright/test").Page,
  name: "test_1.mp4" | "test_3.mp4",
) {
  await page
    .getByRole("button", { name: new RegExp(name.replace(".", "\\.")) })
    .click();
  const item = page
    .locator(".media-panel__results > li")
    .filter({ hasText: name })
    .first();
  await expect(item).toHaveAttribute("data-status", "ready", {
    timeout: 90_000,
  });
  await item.getByRole("button", { name: /添加到时间线/ }).click();
  const cancel = item.getByRole("button", { name: "取消代理" });
  if (await cancel.isVisible()) {
    await cancel.click();
  }
}

async function projectJson(page: import("@playwright/test").Page) {
  const value = await page.getByTestId("project-json").textContent();
  return JSON.parse(value ?? "{}") as {
    clips: Array<{
      effects: Array<{ amount?: number; kind: string }>;
      sourceEndUs: number;
      timelineStartUs: number;
    }>;
    revision: number;
    texts: Array<{
      color: string;
      fontSize: number;
      rotationDeg: number;
      scale: number;
      text: string;
      x: number;
      y: number;
    }>;
  };
}

async function seekTimelineRulerAtUs(
  page: import("@playwright/test").Page,
  timeUs: number,
) {
  await page.getByTestId("timeline-ruler").evaluate((ruler, timeUs) => {
    const element = ruler as HTMLElement;
    const pixelsPerSecond = Number(element.dataset.pixelsPerSecond);
    const box = element.getBoundingClientRect();
    const clientX = box.left + (timeUs / 1_000_000) * pixelsPerSecond;
    const originalSetPointerCapture = HTMLElement.prototype.setPointerCapture;
    HTMLElement.prototype.setPointerCapture = () => undefined;
    try {
      element.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          clientX,
          pointerId: 1,
        }),
      );
      element.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          clientX,
          pointerId: 1,
        }),
      );
    } finally {
      HTMLElement.prototype.setPointerCapture = originalSetPointerCapture;
    }
  }, timeUs);
}

test("edits two real assets with title, filter, split, and Undo/Redo", async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "总编辑器", exact: true }),
  ).toBeVisible();

  await importAndAdd(page, "test_1.mp4");
  await importAndAdd(page, "test_3.mp4");

  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
  await expect(page.getByTestId("audio-track")).toContainText("test_1.mp4");
  await expect(page.getByTestId("audio-track")).toContainText("test_3.mp4");
  await expect(page.locator(".preview-panel")).toHaveAttribute(
    "data-ready",
    "true",
    { timeout: 60_000 },
  );
  await expect(
    page.locator("canvas[data-preview-canvas='pixi-v8']"),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        Number(
          await page
            .locator(".preview-panel")
            .getAttribute("data-presented-frames"),
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Project JSON" }).click();
  const beforeDrag = await projectJson(page);
  const secondClip = page.locator("[data-clip-id]").nth(1);
  await secondClip.scrollIntoViewIfNeeded();
  const secondClipBox = await secondClip.boundingBox();
  expect(secondClipBox).not.toBeNull();
  if (secondClipBox) {
    await page.mouse.move(
      secondClipBox.x + secondClipBox.width / 2,
      secondClipBox.y + secondClipBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      secondClipBox.x + secondClipBox.width / 2 + 32,
      secondClipBox.y + secondClipBox.height / 2,
      { steps: 6 },
    );
    await page.mouse.up();
  }
  const afterDrag = await projectJson(page);
  expect(afterDrag.clips[1]!.timelineStartUs).toBeGreaterThan(
    beforeDrag.clips[1]!.timelineStartUs,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await projectJson(page)).clips[1]!.timelineStartUs).toBe(
    beforeDrag.clips[1]!.timelineStartUs,
  );
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  expect((await projectJson(page)).clips[1]!.timelineStartUs).toBe(
    afterDrag.clips[1]!.timelineStartUs,
  );

  await page.locator("[data-clip-id]").nth(0).click();
  await page.getByLabel("源出点（秒）").fill("8");
  await page.locator("[data-clip-id]").nth(1).click();
  await page.getByLabel("时间线起点（秒）").fill("9");

  await page.locator("[data-clip-id]").nth(0).click();
  await seekTimelineRulerAtUs(page, 4_000_000);
  await page.getByRole("button", { name: "播放头分割" }).click();
  await expect(page.locator("[data-clip-id]")).toHaveCount(3);

  await page.getByRole("button", { name: "添加标题" }).click();
  await page.getByLabel("标题文本").fill("TASK 10 REAL EDIT");
  await page.getByLabel("标题字号").fill("72");
  await page.getByLabel("标题颜色").fill("#ffcc00");
  await page.getByLabel("位置 X").fill("0.62");
  await page.getByLabel("位置 Y").fill("0.22");
  await page.getByLabel("缩放").fill("1.2");
  await page.getByLabel("旋转").fill("-8");

  await page.locator("[data-clip-id]").nth(0).click();
  await page.getByLabel("滤镜类型").selectOption("vintage");
  await page.getByLabel("滤镜强度").fill("0.75");

  await page.getByRole("button", { name: "Project JSON" }).click();
  let project = await projectJson(page);
  expect(project.clips).toHaveLength(3);
  expect(project.clips[0]?.sourceEndUs).toBe(4_000_000);
  expect(project.clips[2]?.timelineStartUs).toBe(9_000_000);
  expect(project.texts[0]).toMatchObject({
    color: "#ffcc00",
    fontSize: 72,
    rotationDeg: -8,
    scale: 1.2,
    text: "TASK 10 REAL EDIT",
    x: 0.62,
    y: 0.22,
  });
  expect(project.clips[0]?.effects[0]).toMatchObject({
    amount: 0.75,
    kind: "vintage",
  });

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  project = await projectJson(page);
  expect(project.clips[0]?.effects[0]).toMatchObject({
    amount: 0.6,
    kind: "vintage",
  });
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  project = await projectJson(page);
  expect(project.clips[0]?.effects[0]).toMatchObject({
    amount: 0.75,
    kind: "vintage",
  });

  await page.screenshot({
    fullPage: true,
    path: "test-results/task10-editor.png",
  });
});

test("keeps MobX actions and reactions isolated from Redux Project", async ({
  page,
}) => {
  await page.goto("/mobx.html");
  await expect(
    page.getByRole("heading", { name: "MobX Clip ViewModel 对照实验" }),
  ).toBeVisible();
  const initialRender = Number(
    await page.getByTestId("mobx-render-count").textContent(),
  );

  await page.getByRole("slider", { name: "MobX 位置 X" }).fill("0.8");
  await page.getByRole("slider", { name: "MobX 旋转" }).fill("35");

  await expect(page.getByTestId("mobx-action-count")).toHaveText("2");
  await expect(page.getByTestId("mobx-reaction-count")).toHaveText("2");
  expect(
    Number(await page.getByTestId("mobx-render-count").textContent()),
  ).toBeGreaterThan(initialRender);
  await expect(page.getByTestId("redux-revision")).toHaveText("0");
  expect(
    await page.evaluate(() => window.__TASK_10_MOBX__?.getReduxRevision()),
  ).toBe(0);

  await page.getByRole("button", { name: "执行 Redux Command" }).click();
  await expect(page.getByTestId("redux-revision")).toHaveText("1");
  await page.screenshot({
    fullPage: true,
    path: "test-results/task10-mobx.png",
  });
});
