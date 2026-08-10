import type { StreamTargetChunk } from "mediabunny";

import {
  MEDIA_PROXY_RESULT_VERSION,
  type ProxyCacheStats,
  type ProxyGenerationParameters,
  type ProxyManifest,
} from "./proxy-types";
import { sampleStorageEstimate } from "./runtime-metrics";

export const MEDIA_PROXY_CACHE_DIRECTORY =
  "web-video-editor-media-cache-v1" as const;
const MANIFEST_FILE = "manifest.json";
const TEMP_PREFIX = ".tmp-";

type DirectoryEntry = [
  string,
  FileSystemDirectoryHandle | FileSystemFileHandle,
];
type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<DirectoryEntry>;
};

export type ProxyCacheTransaction = {
  abort(): Promise<void>;
  commit(manifest: ProxyManifest): Promise<void>;
  createWritable(path: string): Promise<WritableStream<StreamTargetChunk>>;
  write(
    path: string,
    data: ArrayBuffer | ArrayBufferView | Blob,
  ): Promise<void>;
};

export interface ProxyCacheAdapter {
  readonly kind: ProxyCacheStats["adapter"];
  begin(key: string): Promise<ProxyCacheTransaction>;
  cleanup(maxBytes?: number): Promise<ProxyCacheStats>;
  clear(): Promise<void>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<ProxyManifest | null>;
  read(key: string, path: string): Promise<ArrayBuffer>;
  stats(): Promise<ProxyCacheStats>;
}

function encodeManifest(manifest: ProxyManifest): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(manifest));
}

function parseManifest(value: ArrayBuffer, key: string): ProxyManifest {
  const parsed = JSON.parse(new TextDecoder().decode(value)) as ProxyManifest;
  if (
    parsed.version !== MEDIA_PROXY_RESULT_VERSION ||
    parsed.cacheKey !== key ||
    parsed.proxy?.path.length === 0 ||
    !Number.isSafeInteger(parsed.source?.width) ||
    !Number.isSafeInteger(parsed.source?.height) ||
    parsed.cover?.path.length === 0 ||
    parsed.waveform?.path.length === 0 ||
    !Array.isArray(parsed.thumbnails) ||
    !Array.isArray(parsed.keyframes)
  ) {
    throw new Error("Proxy cache manifest is invalid");
  }
  return parsed;
}

function artifactPaths(manifest: ProxyManifest): string[] {
  return [
    manifest.proxy.path,
    manifest.cover.path,
    manifest.waveform.path,
    ...manifest.thumbnails.map((thumbnail) => thumbnail.path),
  ];
}

function resizeBuffer(
  current: Uint8Array<ArrayBuffer>,
  requiredLength: number,
): Uint8Array<ArrayBuffer> {
  if (requiredLength <= current.byteLength) {
    return current;
  }
  let length = Math.max(current.byteLength, 1);
  while (length < requiredLength) {
    length *= 2;
  }
  const next = new Uint8Array(length);
  next.set(current);
  return next;
}

function copyView(view: ArrayBufferView): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy;
}

type MemoryEntry = Map<string, Uint8Array<ArrayBuffer>>;

export class MemoryProxyCache implements ProxyCacheAdapter {
  readonly kind = "memory" as const;

  private readonly entries = new Map<string, MemoryEntry>();
  private readonly temporary = new Map<string, MemoryEntry>();
  private nextTransaction = 1;

  async begin(key: string): Promise<ProxyCacheTransaction> {
    const temporaryKey = `${TEMP_PREFIX}${key}-${this.nextTransaction}`;
    this.nextTransaction += 1;
    const files: MemoryEntry = new Map();
    this.temporary.set(temporaryKey, files);
    let settled = false;

    const write = async (
      path: string,
      data: ArrayBuffer | ArrayBufferView | Blob,
    ): Promise<void> => {
      if (settled) {
        throw new Error("Proxy cache transaction is already settled");
      }
      const buffer =
        data instanceof Blob
          ? await data.arrayBuffer()
          : ArrayBuffer.isView(data)
            ? copyView(data).buffer
            : data.slice(0);
      files.set(path, new Uint8Array(buffer));
    };

    return {
      abort: async () => {
        if (!settled) {
          settled = true;
          this.temporary.delete(temporaryKey);
        }
      },
      commit: async (manifest) => {
        if (settled) {
          throw new Error("Proxy cache transaction is already settled");
        }
        files.set(MANIFEST_FILE, encodeManifest(manifest));
        this.entries.set(key, files);
        this.temporary.delete(temporaryKey);
        settled = true;
      },
      createWritable: async (path) => {
        if (settled) {
          throw new Error("Proxy cache transaction is already settled");
        }
        let data = new Uint8Array();
        let length = 0;
        return new WritableStream<StreamTargetChunk>({
          close: () => {
            files.set(path, data.slice(0, length));
          },
          write: (chunk) => {
            const end = chunk.position + chunk.data.byteLength;
            data = resizeBuffer(data, end);
            data.set(chunk.data, chunk.position);
            length = Math.max(length, end);
          },
        });
      },
      write,
    };
  }

  async cleanup(maxBytes = Number.POSITIVE_INFINITY): Promise<ProxyCacheStats> {
    this.temporary.clear();
    if (Number.isFinite(maxBytes)) {
      const candidates = [...this.entries.entries()]
        .map(([key, files]) => {
          const manifestBytes = files.get(MANIFEST_FILE);
          let createdAt = 0;
          if (manifestBytes) {
            try {
              createdAt = Date.parse(
                parseManifest(
                  manifestBytes.buffer.slice(
                    manifestBytes.byteOffset,
                    manifestBytes.byteOffset + manifestBytes.byteLength,
                  ),
                  key,
                ).createdAt,
              );
            } catch {
              createdAt = 0;
            }
          }
          return { bytes: entryBytes(files), createdAt, key };
        })
        .sort((left, right) => left.createdAt - right.createdAt);
      let total = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const candidate of candidates) {
        if (total <= maxBytes) {
          break;
        }
        this.entries.delete(candidate.key);
        total -= candidate.bytes;
      }
    }
    return this.stats();
  }

  async clear(): Promise<void> {
    this.entries.clear();
    this.temporary.clear();
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async get(key: string): Promise<ProxyManifest | null> {
    const files = this.entries.get(key);
    const bytes = files?.get(MANIFEST_FILE);
    if (!files || !bytes) {
      return null;
    }
    try {
      const manifest = parseManifest(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        key,
      );
      if (artifactPaths(manifest).some((path) => !files.has(path))) {
        throw new Error("Proxy cache artifact is missing");
      }
      return manifest;
    } catch {
      this.entries.delete(key);
      return null;
    }
  }

  async read(key: string, path: string): Promise<ArrayBuffer> {
    const bytes = this.entries.get(key)?.get(path);
    if (!bytes) {
      throw new Error(`Proxy cache artifact "${path}" is unavailable`);
    }
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }

  async stats(): Promise<ProxyCacheStats> {
    return {
      adapter: this.kind,
      committedBytes: [...this.entries.values()].reduce(
        (sum, files) => sum + entryBytes(files),
        0,
      ),
      entries: this.entries.size,
      storageEstimate: { available: false },
      temporaryBytes: [...this.temporary.values()].reduce(
        (sum, files) => sum + entryBytes(files),
        0,
      ),
      temporaryEntries: this.temporary.size,
    };
  }
}

function entryBytes(files: MemoryEntry): number {
  return [...files.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0);
}

async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  path: string,
  data: ArrayBuffer | ArrayBufferView | Blob,
): Promise<void> {
  const file = await directory.getFileHandle(path, { create: true });
  const writable = await file.createWritable();
  await writable.write(ArrayBuffer.isView(data) ? copyView(data) : data);
  await writable.close();
}

async function directoryBytes(
  directory: FileSystemDirectoryHandle,
): Promise<number> {
  let bytes = 0;
  for await (const [, handle] of (directory as IterableDirectory).entries()) {
    if (handle.kind === "file") {
      bytes += (await handle.getFile()).size;
    } else {
      bytes += await directoryBytes(handle);
    }
  }
  return bytes;
}

async function copyFiles(
  source: FileSystemDirectoryHandle,
  destination: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const [name, handle] of (source as IterableDirectory).entries()) {
    if (handle.kind !== "file" || name === MANIFEST_FILE) {
      continue;
    }
    const destinationFile = await destination.getFileHandle(name, {
      create: true,
    });
    const writable = await destinationFile.createWritable();
    await (await handle.getFile()).stream().pipeTo(writable);
  }
}

async function hasEntry(
  directory: FileSystemDirectoryHandle,
  name: string,
  kind: "directory" | "file",
): Promise<boolean> {
  try {
    if (kind === "file") {
      await directory.getFileHandle(name);
    } else {
      await directory.getDirectoryHandle(name);
    }
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return false;
    }
    throw error;
  }
}

export class OpfsProxyCache implements ProxyCacheAdapter {
  readonly kind = "opfs" as const;

  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static async create(): Promise<OpfsProxyCache> {
    if (!navigator.storage?.getDirectory) {
      throw new Error("OPFS is required for the production proxy cache");
    }
    const storageRoot = await navigator.storage.getDirectory();
    const root = await storageRoot.getDirectoryHandle(
      MEDIA_PROXY_CACHE_DIRECTORY,
      {
        create: true,
      },
    );
    const cache = new OpfsProxyCache(root);
    await cache.cleanup();
    return cache;
  }

  async begin(key: string): Promise<ProxyCacheTransaction> {
    const temporaryName = `${TEMP_PREFIX}${key}-${crypto.randomUUID()}`;
    const directory = await this.root.getDirectoryHandle(temporaryName, {
      create: true,
    });
    let settled = false;

    return {
      abort: async () => {
        if (!settled) {
          settled = true;
          await this.root.removeEntry(temporaryName, { recursive: true });
        }
      },
      commit: async (manifest) => {
        if (settled) {
          throw new Error("Proxy cache transaction is already settled");
        }
        await writeOpfsFile(directory, MANIFEST_FILE, encodeManifest(manifest));
        if (await hasEntry(this.root, key, "directory")) {
          await this.root.removeEntry(key, { recursive: true });
        }
        const destination = await this.root.getDirectoryHandle(key, {
          create: true,
        });
        try {
          await copyFiles(directory, destination);
          await writeOpfsFile(
            destination,
            MANIFEST_FILE,
            encodeManifest(manifest),
          );
          await this.root.removeEntry(temporaryName, { recursive: true });
          settled = true;
        } catch (error) {
          await this.root.removeEntry(key, { recursive: true });
          throw error;
        }
      },
      createWritable: async (path) => {
        if (settled) {
          throw new Error("Proxy cache transaction is already settled");
        }
        const file = await directory.getFileHandle(path, { create: true });
        const writable = await file.createWritable();
        return new WritableStream<StreamTargetChunk>({
          abort: async () => writable.abort(),
          close: async () => writable.close(),
          write: async (chunk) => {
            await writable.write({
              data: chunk.data,
              position: chunk.position,
              type: "write",
            });
          },
        });
      },
      write: (path, data) => {
        if (settled) {
          return Promise.reject(
            new Error("Proxy cache transaction is already settled"),
          );
        }
        return writeOpfsFile(directory, path, data);
      },
    };
  }

  async cleanup(maxBytes = Number.POSITIVE_INFINITY): Promise<ProxyCacheStats> {
    const committed: Array<{ bytes: number; createdAt: number; key: string }> =
      [];
    for await (const [name, handle] of (
      this.root as IterableDirectory
    ).entries()) {
      if (name.startsWith(TEMP_PREFIX)) {
        await this.root.removeEntry(name, { recursive: true });
      } else if (handle.kind === "directory") {
        const manifest = await this.get(name);
        if (manifest) {
          committed.push({
            bytes: await directoryBytes(handle),
            createdAt: Date.parse(manifest.createdAt),
            key: name,
          });
        }
      } else {
        await this.root.removeEntry(name);
      }
    }

    if (Number.isFinite(maxBytes)) {
      committed.sort((left, right) => left.createdAt - right.createdAt);
      let total = committed.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of committed) {
        if (total <= maxBytes) {
          break;
        }
        await this.delete(entry.key);
        total -= entry.bytes;
      }
    }
    return this.stats();
  }

  async clear(): Promise<void> {
    for await (const [name] of (this.root as IterableDirectory).entries()) {
      await this.root.removeEntry(name, { recursive: true });
    }
  }

  async delete(key: string): Promise<void> {
    if (await hasEntry(this.root, key, "directory")) {
      await this.root.removeEntry(key, { recursive: true });
    }
  }

  async get(key: string): Promise<ProxyManifest | null> {
    if (!(await hasEntry(this.root, key, "directory"))) {
      return null;
    }
    try {
      const directory = await this.root.getDirectoryHandle(key);
      const manifest = parseManifest(
        await (
          await directory.getFileHandle(MANIFEST_FILE)
        )
          .getFile()
          .then((file) => file.arrayBuffer()),
        key,
      );
      for (const path of artifactPaths(manifest)) {
        if (!(await hasEntry(directory, path, "file"))) {
          throw new Error(`Proxy cache artifact "${path}" is missing`);
        }
      }
      return manifest;
    } catch {
      await this.delete(key);
      return null;
    }
  }

  async read(key: string, path: string): Promise<ArrayBuffer> {
    const directory = await this.root.getDirectoryHandle(key);
    const file = await directory.getFileHandle(path);
    return (await file.getFile()).arrayBuffer();
  }

  async stats(): Promise<ProxyCacheStats> {
    let committedBytes = 0;
    let entries = 0;
    let temporaryBytes = 0;
    let temporaryEntries = 0;
    for await (const [name, handle] of (
      this.root as IterableDirectory
    ).entries()) {
      if (handle.kind !== "directory") {
        continue;
      }
      const bytes = await directoryBytes(handle);
      if (name.startsWith(TEMP_PREFIX)) {
        temporaryBytes += bytes;
        temporaryEntries += 1;
      } else {
        committedBytes += bytes;
        entries += 1;
      }
    }
    return {
      adapter: this.kind,
      committedBytes,
      entries,
      storageEstimate: await sampleStorageEstimate(),
      temporaryBytes,
      temporaryEntries,
    };
  }
}

export async function createProxyCacheKey(
  fingerprint: string,
  parameters: ProxyGenerationParameters,
): Promise<string> {
  const encoded = new TextEncoder().encode(
    JSON.stringify({ fingerprint, parameters }),
  );
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `proxy-${hash}`;
}

export async function listOpfsProxyManifests(): Promise<ProxyManifest[]> {
  const storageRoot = await navigator.storage.getDirectory();
  const root = await storageRoot.getDirectoryHandle(
    MEDIA_PROXY_CACHE_DIRECTORY,
    { create: true },
  );
  const manifests: ProxyManifest[] = [];
  for await (const [name, handle] of (root as IterableDirectory).entries()) {
    if (name.startsWith(TEMP_PREFIX) || handle.kind !== "directory") {
      continue;
    }
    try {
      const bytes = await (
        await handle.getFileHandle(MANIFEST_FILE)
      )
        .getFile()
        .then((file) => file.arrayBuffer());
      manifests.push(parseManifest(bytes, name));
    } catch {
      continue;
    }
  }
  return manifests;
}

export async function getOpfsProxyFile(
  cacheKey: string,
  path: string,
): Promise<File> {
  const storageRoot = await navigator.storage.getDirectory();
  const root = await storageRoot.getDirectoryHandle(
    MEDIA_PROXY_CACHE_DIRECTORY,
  );
  const directory = await root.getDirectoryHandle(cacheKey);
  return (await directory.getFileHandle(path)).getFile();
}
