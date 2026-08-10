import { expect, test } from "@playwright/test";

test("detects browser capabilities and exposes read-only test assets", async ({
  page,
  request,
}) => {
  const capabilityLogs: Array<Record<string, unknown>> = [];
  page.on("console", (message) => {
    try {
      const entry = JSON.parse(message.text()) as Record<string, unknown>;
      if (entry.marker === "[CAPABILITY]") {
        capabilityLogs.push(entry);
      }
    } catch {
      // Browser diagnostics that are not part of the structured log contract.
    }
  });

  const response = await page.goto("/");
  expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe(
    "require-corp",
  );

  await expect(
    page.getByRole("heading", { name: "总编辑器", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "能力", exact: true }).click();
  await expect(
    page.locator('[data-capability-id="crossOriginIsolated"]'),
  ).toHaveAttribute("data-supported", "true");
  await expect(page.locator("[data-capability-id]")).toHaveCount(12);
  await expect.poll(() => capabilityLogs.length).toBeGreaterThan(0);

  const log = capabilityLogs[0];
  expect(log?.event).toBe("capability.detected");
  expect(log?.scope).toBe("editor-bootstrap");
  expect(log).not.toHaveProperty("error");
  expect(log?.output).toEqual(
    expect.objectContaining({
      actions: expect.any(Array),
      capabilities: expect.any(Array),
    }),
  );

  const assetResponse = await request.get("/test_assets/test_1.mp4", {
    headers: { Range: "bytes=0-15" },
  });
  expect(assetResponse.status()).toBe(206);
  expect(assetResponse.headers()["content-type"]).toContain("video/mp4");
  expect(assetResponse.headers()["content-range"]).toBe("bytes 0-15/2879822");
  expect((await assetResponse.body()).byteLength).toBe(16);

  const writeResponse = await request.post("/test_assets/test_1.mp4");
  expect(writeResponse.status()).toBe(405);
  expect(writeResponse.headers().allow).toBe("GET, HEAD");
});

test("disables capability-dependent actions with diagnostic suggestions", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(globalThis, "SharedArrayBuffer", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {},
    });
  });

  await page.goto("/");

  await expect(page.getByText("导入已禁用：", { exact: false })).toContainText(
    "建议",
  );
  await expect(page.getByLabel("选择 MP4")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /test_1\.mp4/ }),
  ).toBeDisabled();

  const preview = page.locator(".preview-panel");
  await expect(
    preview.getByText("预览已禁用：", { exact: false }),
  ).toContainText("Worker");
  await expect(
    preview.getByRole("button", { name: "播放", exact: true }),
  ).toBeDisabled();

  await expect(page.getByRole("button", { name: "开始导出" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "SyncDebugPanel" }),
  ).toBeDisabled();
  await expect(page.getByTestId("shared-memory-diagnosis")).toContainText(
    "SharedArrayBuffer",
  );
});
