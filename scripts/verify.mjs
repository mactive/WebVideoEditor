import { spawnSync } from "node:child_process";
import { Console } from "node:console";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { createServer } from "node:net";

import { chromium } from "@playwright/test";

const output = new Console({
  stderr: process.stderr,
  stdout: process.stdout,
});

async function allocateE2ePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0 || port === 4173) {
    return allocateE2ePort();
  }
  return port;
}

const steps = [
  ["docs-check", "pnpm", ["docs:check"]],
  ["format-check", "pnpm", ["format:check"]],
  ["lint", "pnpm", ["lint"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["rust-format", "cargo", ["fmt", "--check"]],
  [
    "rust-clippy",
    "cargo",
    ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
  ],
  ["cargo-test", "pnpm", ["test:rust"]],
  ["wasm-browser-test", "pnpm", ["test:wasm"]],
  ["vitest", "pnpm", ["test"]],
  ["production-build", "pnpm", ["build"]],
  ["playwright-core", "pnpm", ["test:e2e:core"]],
];

const startedAt = performance.now();
const results = [];
const e2ePort = await allocateE2ePort();
output.log(`[VERIFY] Reserved isolated E2E port ${e2ePort}`);

for (const [name, command, args] of steps) {
  const stepStartedAt = performance.now();
  output.log(`\n[VERIFY] START ${name}: ${command} ${args.join(" ")}`);
  const browserHome =
    name === "wasm-browser-test"
      ? mkdtempSync(join(tmpdir(), "web-video-editor-browser-"))
      : undefined;
  const webdriverConfig = browserHome
    ? join(browserHome, "webdriver.json")
    : undefined;
  if (webdriverConfig) {
    writeFileSync(
      webdriverConfig,
      JSON.stringify({
        "goog:chromeOptions": {
          binary: chromium.executablePath(),
          args: [
            "--disable-breakpad",
            "--disable-crash-reporter",
            "--disable-crashpad",
            "--no-default-browser-check",
            "--no-first-run",
            `--user-data-dir=${join(browserHome, "chrome-profile")}`,
          ],
        },
      }),
    );
  }
  const env = {
    ...process.env,
    ...(name === "playwright-core" ? { E2E_PORT: String(e2ePort) } : {}),
    ...(browserHome
      ? {
          CARGO_HOME: process.env.CARGO_HOME ?? join(homedir(), ".cargo"),
          CFFIXED_USER_HOME: browserHome,
          HOME: browserHome,
          RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
          WASM_PACK_CACHE:
            process.env.WASM_PACK_CACHE ??
            join(homedir(), "Library", "Caches", ".wasm-pack"),
          WASM_BINDGEN_TEST_WEBDRIVER_JSON: webdriverConfig,
        }
      : {}),
  };
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (browserHome) {
    rmSync(browserHome, { force: true, recursive: true });
  }
  const durationMs = performance.now() - stepStartedAt;
  if (result.error || result.status !== 0) {
    output.error(
      `\n[VERIFY] FAIL ${name} after ${(durationMs / 1_000).toFixed(2)}s`,
    );
    if (result.error) {
      output.error(`[VERIFY] ${result.error.message}`);
    }
    output.error(
      `[VERIFY] Reproduce: ${command} ${args.join(" ")} (cwd=${process.cwd()})`,
    );
    process.exit(result.status ?? 1);
  }
  results.push({ durationMs, name });
  output.log(`[VERIFY] PASS ${name} ${(durationMs / 1_000).toFixed(2)}s`);
}

output.log("\n[VERIFY] SUMMARY");
for (const result of results) {
  output.log(
    `[VERIFY] ${result.name.padEnd(20)} ${(result.durationMs / 1_000).toFixed(2)}s`,
  );
}
output.log(
  `[VERIFY] ALL PASS ${((performance.now() - startedAt) / 1_000).toFixed(2)}s`,
);
