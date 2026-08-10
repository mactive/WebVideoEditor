import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const assetRoute = "/test_assets/";
const assetRoot = fileURLToPath(new URL("../../test_assets/", import.meta.url));
const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

type MiddlewareStack = {
  use(
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
      next: () => void,
    ) => void,
  ): void;
};

type ByteRange = {
  end: number;
  start: number;
};

function parseRange(value: string, size: number): ByteRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) {
    return undefined;
  }

  const rawStart = match[1];
  const rawEnd = match[2];
  const start = rawStart
    ? Number(rawStart)
    : Math.max(size - Number(rawEnd), 0);
  const end = rawStart ? (rawEnd ? Number(rawEnd) : size - 1) : size - 1;

  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return undefined;
  }

  return { start, end: Math.min(end, size - 1) };
}

function contentType(filePath: string): string {
  return extname(filePath).toLowerCase() === ".mp4"
    ? "video/mp4"
    : "application/octet-stream";
}

async function serveReadonlyAsset(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("Allow", "GET, HEAD");
    response.end("Method Not Allowed");
    return;
  }

  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const requestedPath = decodeURIComponent(pathname.slice(assetRoute.length));
    const candidate = resolve(assetRoot, requestedPath);
    const relativePath = relative(assetRoot, candidate);

    if (
      requestedPath.length === 0 ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath === ".."
    ) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    const [realRoot, realCandidate] = await Promise.all([
      realpath(assetRoot),
      realpath(candidate),
    ]);
    if (
      realCandidate !== realRoot &&
      !realCandidate.startsWith(`${realRoot}${sep}`)
    ) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    const assetStat = await stat(realCandidate);
    if (!assetStat.isFile()) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", contentType(realCandidate));
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    const rangeHeader = request.headers.range;
    const range = rangeHeader
      ? parseRange(rangeHeader, assetStat.size)
      : undefined;
    if (rangeHeader && !range) {
      response.statusCode = 416;
      response.setHeader("Content-Range", `bytes */${assetStat.size}`);
      response.end();
      return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? assetStat.size - 1;
    response.statusCode = range ? 206 : 200;
    response.setHeader("Content-Length", String(end - start + 1));
    if (range) {
      response.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${assetStat.size}`,
      );
    }

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(realCandidate, { start, end }).pipe(response);
  } catch {
    response.statusCode = 404;
    response.end("Not Found");
  }
}

function readonlyTestAssets(): Plugin {
  const install = (middlewares: MiddlewareStack) => {
    middlewares.use((request, response, next) => {
      if (!request.url?.startsWith(assetRoute)) {
        next();
        return;
      }
      void serveReadonlyAsset(request, response);
    });
  };

  return {
    name: "readonly-test-assets",
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), readonlyTestAssets()],
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        mobx: fileURLToPath(new URL("./mobx.html", import.meta.url)),
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
        syncDebug: fileURLToPath(new URL("./sync-debug.html", import.meta.url)),
      },
    },
  },
  server: {
    fs: {
      strict: true,
    },
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
});
