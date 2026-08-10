import { defineConfig, devices } from "@playwright/test";

const e2ePort = Number(process.env.E2E_PORT ?? 4173);
const e2eBaseUrl = `http://127.0.0.1:${e2ePort}`;
const e2eServerMode = process.env.E2E_SERVER_MODE === "preview";

export default defineConfig({
  testDir: "./apps/editor/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: e2eBaseUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--disable-breakpad",
            "--disable-crash-reporter",
            "--disable-crashpad",
            "--enable-precise-memory-info",
          ],
        },
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @web-video-editor/editor ${
      e2eServerMode ? "preview" : "dev"
    } --host 127.0.0.1 --port ${e2ePort} --strictPort`,
    url: e2eBaseUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
