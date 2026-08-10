import { open, realpath, stat } from "node:fs/promises";
import { basename } from "node:path";

import { CustomSource } from "mediabunny";

import {
  MediaReadTracker,
  probeMediaSource,
  type ProbeMediaOptions,
} from "./probe";
import type { MediaProbeResult } from "./probe-types";

export async function probeNodeFile(
  filePath: string,
  options: ProbeMediaOptions = {},
): Promise<MediaProbeResult> {
  const resolvedPath = await realpath(filePath);
  const fileStat = await stat(resolvedPath);
  if (!fileStat.isFile()) {
    throw new TypeError(`Media input is not a file: ${resolvedPath}`);
  }

  const handle = await open(resolvedPath, "r");
  let closed = false;
  const source = new CustomSource({
    dispose: () => {
      if (!closed) {
        closed = true;
        void handle.close();
      }
    },
    getSize: () => fileStat.size,
    maxCacheSize: 8 * 1024 * 1024,
    prefetchProfile: "fileSystem",
    read: async (start, end) => {
      const bytes = new Uint8Array(end - start);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) {
        throw new Error(
          `Short media read at ${start}: expected ${bytes.length}, got ${bytesRead}`,
        );
      }
      return bytes;
    },
  });

  return probeMediaSource(
    source,
    {
      kind: "path",
      lastModified: Math.round(fileStat.mtimeMs),
      name: basename(resolvedPath),
    },
    new MediaReadTracker(),
    options,
  );
}
