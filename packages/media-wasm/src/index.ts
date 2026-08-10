import {
  ConsoleLogSink,
  StructuredLogger,
  type LogDraft,
  type LogEntry,
} from "@web-video-editor/observability";

export type WasmLogEvent = LogEntry & { marker: "[WASM]" };
export type WasmLogger = StructuredLogger;

interface RawPcmWaveformAccumulator {
  readonly processed_samples: number;
  readonly expected_samples: number;
  readonly buckets: number;
  push(samples: Float32Array): void;
  finish(): Float32Array;
  free(): void;
}

interface WasmBindings {
  default?: (input?: unknown) => unknown | Promise<unknown>;
  seconds_to_microseconds(seconds: number): number;
  microseconds_to_seconds(microseconds: number): number;
  frame_to_microseconds(
    frame: number,
    fpsNumerator: number,
    fpsDenominator: number,
  ): number;
  microseconds_to_frame(
    microseconds: number,
    fpsNumerator: number,
    fpsDenominator: number,
  ): number;
  summarize_bytes(bytes: Uint8Array): Uint32Array;
  PcmWaveformAccumulator: new (
    totalSamples: number,
    bucketCount: number,
  ) => RawPcmWaveformAccumulator;
}

export type WasmModuleLoader = () => Promise<WasmBindings>;

export interface InitMediaWasmOptions {
  loader?: WasmModuleLoader;
  logger?: WasmLogger;
  requestId?: string;
}

export interface WaveformResult {
  bucketCount: number;
  sampleCount: number;
  data: Float32Array;
  min: Float32Array;
  max: Float32Array;
  rms: Float32Array;
}

export interface ByteSummary {
  byteLength: number;
  checksum32: number;
  min: number;
  max: number;
  xor: number;
  data: Uint32Array;
}

const defaultLoader: WasmModuleLoader = async () =>
  (await import("../pkg/media_wasm.js")) as WasmBindings;

const defaultLogger = new StructuredLogger(new ConsoleLogSink(), "media-wasm");

const now = (): number =>
  typeof performance === "undefined" ? Date.now() : performance.now();

type WasmLogDraft = Omit<LogDraft<"[WASM]">, "marker" | "scope">;

function logWasm(
  logger: WasmLogger,
  draft: WasmLogDraft,
  requestId?: string,
): WasmLogEvent {
  return logger.log({
    ...draft,
    marker: "[WASM]",
    requestId: draft.requestId ?? requestId,
    scope: "media-wasm",
  }) as WasmLogEvent;
}

export class PcmWaveformSession {
  constructor(
    private readonly raw: RawPcmWaveformAccumulator,
    private readonly logger: WasmLogger,
    private readonly requestId?: string,
  ) {}

  push(samples: Float32Array): void {
    const started = now();
    try {
      this.raw.push(samples);
    } catch (error) {
      logWasm(
        this.logger,
        {
          event: "call.failed",
          input: { operation: "waveform.chunk", samples: samples.length },
          durationMs: now() - started,
          error,
          level: "error",
        },
        this.requestId,
      );
      throw error;
    }
  }

  finish(): WaveformResult {
    const started = now();
    try {
      const data = this.raw.finish();
      const bucketCount = this.raw.buckets;
      if (data.length !== bucketCount * 3) {
        throw new Error(
          `Invalid waveform output length: expected ${bucketCount * 3}, received ${data.length}`,
        );
      }
      const result = {
        bucketCount,
        sampleCount: this.raw.expected_samples,
        data,
        min: data.subarray(0, bucketCount),
        max: data.subarray(bucketCount, bucketCount * 2),
        rms: data.subarray(bucketCount * 2),
      };
      logWasm(
        this.logger,
        {
          event: "waveform.completed",
          input: { operation: "waveform.finish", samples: result.sampleCount },
          output: {
            buckets: result.bucketCount,
            values: result.data.length,
            type: result.data.constructor.name,
          },
          durationMs: now() - started,
          level: "info",
        },
        this.requestId,
      );
      return result;
    } catch (error) {
      logWasm(
        this.logger,
        {
          event: "call.failed",
          input: {
            operation: "waveform.finish",
            processedSamples: this.raw.processed_samples,
            expectedSamples: this.raw.expected_samples,
          },
          durationMs: now() - started,
          error,
          level: "error",
        },
        this.requestId,
      );
      throw error;
    }
  }

  dispose(): void {
    this.raw.free();
  }
}

export class MediaWasmSdk {
  constructor(
    private readonly bindings: WasmBindings,
    private readonly logger: WasmLogger,
    private readonly requestId?: string,
  ) {}

  secondsToMicroseconds(seconds: number): number {
    return this.measure("timeline.seconds-to-microseconds", { seconds }, () =>
      this.bindings.seconds_to_microseconds(seconds),
    );
  }

  microsecondsToSeconds(microseconds: number): number {
    return this.measure(
      "timeline.microseconds-to-seconds",
      { microseconds },
      () => this.bindings.microseconds_to_seconds(microseconds),
    );
  }

  frameToMicroseconds(
    frame: number,
    fpsNumerator: number,
    fpsDenominator = 1,
  ): number {
    return this.measure(
      "timeline.frame-to-microseconds",
      { frame, fpsNumerator, fpsDenominator },
      () =>
        this.bindings.frame_to_microseconds(
          frame,
          fpsNumerator,
          fpsDenominator,
        ),
    );
  }

  microsecondsToFrame(
    microseconds: number,
    fpsNumerator: number,
    fpsDenominator = 1,
  ): number {
    return this.measure(
      "timeline.microseconds-to-frame",
      { microseconds, fpsNumerator, fpsDenominator },
      () =>
        this.bindings.microseconds_to_frame(
          microseconds,
          fpsNumerator,
          fpsDenominator,
        ),
    );
  }

  createWaveform(
    totalSamples: number,
    bucketCount: number,
  ): PcmWaveformSession {
    const raw = new this.bindings.PcmWaveformAccumulator(
      totalSamples,
      bucketCount,
    );
    logWasm(
      this.logger,
      {
        event: "call.started",
        input: { operation: "waveform.create", totalSamples, bucketCount },
        level: "info",
      },
      this.requestId,
    );
    return new PcmWaveformSession(raw, this.logger, this.requestId);
  }

  summarizeBytes(input: ArrayBuffer | Uint8Array): ByteSummary {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const data = this.measure(
      "binary.summary",
      { byteLength: bytes.byteLength, type: bytes.constructor.name },
      () => this.bindings.summarize_bytes(bytes),
      (output) => ({
        byteLength: output[0],
        checksum32: output[1],
      }),
    );
    if (data.length !== 5) {
      throw new Error(
        `Invalid byte summary length: expected 5, received ${data.length}`,
      );
    }
    return {
      byteLength: data[0]!,
      checksum32: data[1]!,
      min: data[2]!,
      max: data[3]!,
      xor: data[4]!,
      data,
    };
  }

  private measure<T>(
    operationName: string,
    input: Record<string, unknown>,
    run: () => T,
    summarizeOutput: (output: T) => Record<string, unknown> = (output) => ({
      value: output,
    }),
  ): T {
    const started = now();
    try {
      const output = run();
      logWasm(
        this.logger,
        {
          event:
            operationName === "binary.summary"
              ? "binary.validated"
              : "call.completed",
          input: { operation: operationName, ...input },
          output: { operation: operationName, ...summarizeOutput(output) },
          durationMs: now() - started,
          level: "info",
        },
        this.requestId,
      );
      return output;
    } catch (error) {
      logWasm(
        this.logger,
        {
          event: "call.failed",
          input: { operation: operationName, ...input },
          durationMs: now() - started,
          error,
          level: "error",
        },
        this.requestId,
      );
      throw error;
    }
  }
}

export async function initMediaWasm(
  options: InitMediaWasmOptions = {},
): Promise<MediaWasmSdk> {
  const logger = options.logger ?? defaultLogger;
  const started = now();
  logWasm(
    logger,
    {
      event: "call.started",
      input: { operation: "init" },
      level: "info",
    },
    options.requestId,
  );
  try {
    const bindings = await (options.loader ?? defaultLoader)();
    if (typeof bindings.default === "function") {
      await bindings.default();
    }
    logWasm(
      logger,
      {
        event: "call.completed",
        input: { operation: "init" },
        durationMs: now() - started,
        level: "info",
      },
      options.requestId,
    );
    return new MediaWasmSdk(bindings, logger, options.requestId);
  } catch (error) {
    logWasm(
      logger,
      {
        event: "call.failed",
        input: { operation: "init" },
        durationMs: now() - started,
        error,
        level: "error",
      },
      options.requestId,
    );
    throw new Error("Failed to initialize media WASM SDK", { cause: error });
  }
}
