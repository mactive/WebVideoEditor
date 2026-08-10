import type { LogValue, SerializedLogError } from "./types";

export type SummarizeOptions = {
  maxArrayItems?: number;
  maxDepth?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
};

const defaultOptions: Required<SummarizeOptions> = {
  maxArrayItems: 50,
  maxDepth: 8,
  maxObjectKeys: 50,
  maxStringLength: 4_096,
};

const binarySampleLimit = 4_096;

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function fnv1a32(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function sampleBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength <= binarySampleLimit) {
    return bytes;
  }

  const half = binarySampleLimit / 2;
  const sample = new Uint8Array(binarySampleLimit);
  sample.set(bytes.subarray(0, half));
  sample.set(bytes.subarray(bytes.byteLength - half), half);
  return sample;
}

function binarySummary(
  type: string,
  bytes: Uint8Array,
): Record<string, LogValue> {
  const sample = sampleBytes(bytes);
  return {
    byteLength: bytes.byteLength,
    digest: fnv1a32(sample),
    kind: "binary",
    sampledBytes: sample.byteLength,
    type,
  };
}

function bytesForView(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function constructorName(value: object): string {
  return value.constructor?.name || "Object";
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isMediaResource(value: object): boolean {
  return [
    "AudioData",
    "AudioDecoder",
    "AudioEncoder",
    "ImageBitmap",
    "OffscreenCanvas",
    "VideoDecoder",
    "VideoEncoder",
    "VideoFrame",
    "Worker",
  ].includes(constructorName(value));
}

function summarizeInternal(
  value: unknown,
  options: Required<SummarizeOptions>,
  seen: WeakSet<object>,
  depth: number,
): LogValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return typeof value === "string"
      ? truncate(value, options.maxStringLength)
      : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return `${value.toString()}n`;
  }
  if (typeof value === "undefined") {
    return "[undefined]";
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  if (depth >= options.maxDepth) {
    return `[max-depth:${options.maxDepth}]`;
  }

  if (value instanceof ArrayBuffer) {
    return binarySummary("ArrayBuffer", new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return binarySummary(constructorName(value), bytesForView(value));
  }
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    value instanceof SharedArrayBuffer
  ) {
    return binarySummary("SharedArrayBuffer", new Uint8Array(value));
  }
  if (isBlob(value)) {
    return {
      byteLength: value.size,
      digest: "unavailable:blob-not-read",
      kind: "binary",
      mimeType: value.type || "application/octet-stream",
      type: constructorName(value),
    };
  }
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf()) ? "Invalid Date" : value.toISOString();
  }

  const object = value as object;
  if (seen.has(object)) {
    return "[circular]";
  }
  seen.add(object);

  if (isMediaResource(object)) {
    return {
      kind: "runtime-resource",
      type: constructorName(object),
    };
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, options.maxArrayItems)
      .map((item) => summarizeInternal(item, options, seen, depth + 1));
    if (value.length > options.maxArrayItems) {
      items.push(`[truncated ${value.length - options.maxArrayItems} items]`);
    }
    return items;
  }

  if (value instanceof Map) {
    return summarizeInternal(
      {
        entries: Array.from(value.entries()).slice(0, options.maxObjectKeys),
        kind: "Map",
        size: value.size,
      },
      options,
      seen,
      depth + 1,
    );
  }
  if (value instanceof Set) {
    return summarizeInternal(
      {
        items: Array.from(value).slice(0, options.maxArrayItems),
        kind: "Set",
        size: value.size,
      },
      options,
      seen,
      depth + 1,
    );
  }

  const summary: Record<string, LogValue> = {};
  const keys = Object.keys(value as Record<string, unknown>);
  for (const key of keys.slice(0, options.maxObjectKeys)) {
    try {
      summary[key] = summarizeInternal(
        (value as Record<string, unknown>)[key],
        options,
        seen,
        depth + 1,
      );
    } catch (error) {
      summary[key] =
        `[unreadable:${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  if (keys.length > options.maxObjectKeys) {
    summary["[truncatedKeys]"] = keys.length - options.maxObjectKeys;
  }
  return summary;
}

export function summarize(
  value: unknown,
  options: SummarizeOptions = {},
): LogValue {
  return summarizeInternal(
    value,
    { ...defaultOptions, ...options },
    new WeakSet<object>(),
    0,
  );
}

function errorContext(error: Error): LogValue | undefined {
  const context: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    if (key !== "cause") {
      context[key] = (error as unknown as Record<string, unknown>)[key];
    }
  }
  return Object.keys(context).length > 0 ? summarize(context) : undefined;
}

export function serializeError(
  error: unknown,
  context?: unknown,
): SerializedLogError {
  if (error instanceof Error) {
    const serialized: SerializedLogError = {
      message: error.message,
      name: error.name || "Error",
    };
    if (error.stack) {
      serialized.stack = truncate(error.stack, 16_384);
    }
    if ("cause" in error && error.cause !== undefined) {
      serialized.cause =
        error.cause instanceof Error
          ? serializeError(error.cause)
          : summarize(error.cause);
    }
    const combinedContext =
      context === undefined
        ? errorContext(error)
        : summarize({
            errorProperties: errorContext(error),
            operation: context,
          });
    if (combinedContext !== undefined) {
      serialized.context = combinedContext;
    }
    return serialized;
  }

  return {
    context: context === undefined ? undefined : summarize(context),
    message:
      typeof error === "string" ? error : JSON.stringify(summarize(error)),
    name: "NonErrorThrown",
  };
}
