import { describe, expect, it, vi } from "vitest";

import {
  CliLogSink,
  ConsoleLogSink,
  EVENT_DICTIONARY,
  LogHub,
  LogSchemaError,
  MARKER_EVENTS,
  MARKER_LOG_EXAMPLES,
  StructuredLogger,
  WasmLogSink,
  WorkerLogSink,
  createLogEntry,
  createRequestId,
  isLogEntry,
  parseLogEntry,
  receiveWorkerLog,
  serializeError,
  summarize,
  validateLogEntry,
  type ConsoleTarget,
  type WorkerLogMessage,
} from "./index";

const fixedClock = () => new Date("2026-08-09T12:00:00.000Z");

describe("strict log schema", () => {
  it("accepts every registered marker example", () => {
    const exampleMarkers = new Set(
      MARKER_LOG_EXAMPLES.map((entry) => entry.marker),
    );

    expect(exampleMarkers).toEqual(new Set(Object.keys(MARKER_EVENTS)));
    expect(MARKER_LOG_EXAMPLES.every(isLogEntry)).toBe(true);
    expect(Object.keys(EVENT_DICTIONARY)).toEqual(Object.keys(MARKER_EVENTS));
  });

  it("rejects unknown fields and marker/event mismatches", () => {
    const valid = MARKER_LOG_EXAMPLES[0];

    expect(() =>
      parseLogEntry({ ...valid, event: "packet", secret: "not allowed" }),
    ).toThrow(LogSchemaError);
    expect(
      validateLogEntry({ ...valid, event: "packet", secret: "not allowed" }),
    ).toEqual(
      expect.arrayContaining([
        'entry contains unknown field "secret"',
        "event is not registered for marker [CAPABILITY]",
      ]),
    );
  });

  it("rejects null errors instead of treating them as absent", () => {
    expect(
      validateLogEntry({ ...MARKER_LOG_EXAMPLES[0], error: null }),
    ).toContain("error must be a serialized error object");
    expect(() =>
      parseLogEntry({ ...MARKER_LOG_EXAMPLES[0], error: null }),
    ).toThrow(LogSchemaError);
  });

  it("rejects raw binary and malformed scalar fields", () => {
    const issues = validateLogEntry({
      event: "packet",
      input: new Uint8Array([1, 2, 3]),
      level: "verbose",
      marker: "[DEMUX]",
      projectRevision: -1,
      requestId: "contains spaces",
      scope: "",
      timestamp: "today",
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        "timestamp must be an ISO 8601 UTC string with milliseconds",
        "level must be one of: debug, info, warn, error",
        "scope must be a non-empty stable identifier",
        "requestId must be a non-empty stable identifier",
        "projectRevision must be a non-negative safe integer",
        "input must not contain raw binary or runtime objects",
      ]),
    );
  });

  it("accepts repeated JSON references but rejects actual cycles", () => {
    const repeated = { value: 1 };
    const valid = {
      ...MARKER_LOG_EXAMPLES[0],
      input: { first: repeated, second: repeated },
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(validateLogEntry(valid)).toEqual([]);
    expect(
      validateLogEntry({ ...MARKER_LOG_EXAMPLES[0], input: cyclic }),
    ).toContain("input.self must not contain circular references");
  });
});

describe("safe serialization", () => {
  it("replaces binary values with bounded deterministic summaries", () => {
    const bytes = new Uint8Array(10_000);
    bytes[0] = 12;
    bytes[9_999] = 34;

    const first = summarize({ packet: bytes });
    const second = summarize({ packet: bytes });
    const packet = (first as Record<string, unknown>).packet as Record<
      string,
      unknown
    >;

    expect(first).toEqual(second);
    expect(packet).toMatchObject({
      byteLength: 10_000,
      kind: "binary",
      sampledBytes: 4_096,
      type: "Uint8Array",
    });
    expect(packet.digest).toMatch(/^fnv1a32:[0-9a-f]{8}$/);
    expect(JSON.stringify(first)).not.toContain("[0,0,0");
  });

  it("serializes nested errors and operation context", () => {
    const cause = new TypeError("bad codec");
    const error = new Error("decode failed", { cause });
    Object.assign(error, { codec: "avc1.640028", queueSize: 8 });

    const serialized = serializeError(error, {
      path: "/test_assets/test_2.mp4",
      requestId: "seek_42",
    });

    expect(serialized).toMatchObject({
      cause: { message: "bad codec", name: "TypeError" },
      message: "decode failed",
      name: "Error",
    });
    expect(serialized.context).toEqual(
      expect.objectContaining({
        operation: expect.objectContaining({
          path: "/test_assets/test_2.mp4",
          requestId: "seek_42",
        }),
      }),
    );
  });

  it("summarizes circular and non-JSON values without throwing", () => {
    const input: Record<string, unknown> = {
      bigint: 12n,
      missing: undefined,
    };
    input.self = input;

    expect(summarize(input)).toEqual({
      bigint: "12n",
      missing: "[undefined]",
      self: "[circular]",
    });
  });
});

describe("sinks and request tracing", () => {
  it("emits one JSON object to the matching console level", () => {
    const target: ConsoleTarget = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const sink = new ConsoleLogSink(target);
    const entry = MARKER_LOG_EXAMPLES[2];
    if (!entry) {
      throw new Error("missing example");
    }

    sink.write(entry);

    expect(target.info).toHaveBeenCalledWith(JSON.stringify(entry));
    expect(target.error).not.toHaveBeenCalled();
  });

  it("writes separate human and machine-readable CLI streams", () => {
    let human = "";
    let jsonl = "";
    const sink = new CliLogSink({
      humanWriter: (line) => {
        human += line;
      },
      jsonlWriter: (line) => {
        jsonl += line;
      },
    });
    const entry = MARKER_LOG_EXAMPLES.at(-1);
    if (!entry) {
      throw new Error("missing example");
    }

    sink.write(entry);

    expect(human).toContain(
      "[PROBE] INFO probe-cli summary requestId=probe_01",
    );
    expect(JSON.parse(jsonl.trim())).toEqual(entry);
  });

  it("adapts WASM diagnostics to the shared schema", () => {
    const hub = new LogHub();
    const sink = new WasmLogSink(hub, "wasm-wrapper", fixedClock);

    const entry = sink.write({
      durationMs: 2.4,
      event: "binary.validated",
      input: new Uint8Array([1, 2, 3]),
      output: { valid: true },
      requestId: "wasm_01",
    });

    expect(entry).toBeDefined();
    expect(entry!.marker).toBe("[WASM]");
    expect(entry!.input).toEqual(
      expect.objectContaining({ kind: "binary", type: "Uint8Array" }),
    );
    expect(hub.getEntries()).toEqual([entry!]);
  });

  it("restores a cross-thread seek trace in receive order", () => {
    const messages: WorkerLogMessage[] = [];
    const workerSink = new WorkerLogSink({
      postMessage: (message) => messages.push(structuredClone(message)),
    });
    const workerLogger = new StructuredLogger(
      workerSink,
      "media-worker",
      fixedClock,
    );
    const trace = workerLogger.trace({
      projectRevision: 12,
      requestId: "seek_42",
    });

    trace.log({
      event: "request",
      input: { timeSec: 18.4 },
      level: "debug",
      marker: "[SEEK]",
      scope: "scheduler",
    });
    trace.log({
      event: "packet",
      level: "debug",
      marker: "[DEMUX]",
      output: new Uint8Array([0, 0, 1, 103]),
    });
    trace.log({
      event: "frame",
      level: "debug",
      marker: "[DECODE]",
      output: { timestampUs: 18_400_000 },
    });
    trace.log({
      event: "evaluate",
      level: "debug",
      marker: "[ECS]",
      output: { visibleEntities: 2 },
      scope: "preview-runtime",
    });
    trace.log({
      event: "present",
      level: "debug",
      marker: "[RENDER]",
      output: { width: 960 },
      scope: "preview-renderer",
    });

    const mainHub = new LogHub();
    messages.forEach((message) => receiveWorkerLog(message, mainHub));
    const restored = mainHub.query({ requestId: "seek_42" });

    expect(restored.map((entry) => entry.marker)).toEqual([
      "[SEEK]",
      "[DEMUX]",
      "[DECODE]",
      "[ECS]",
      "[RENDER]",
    ]);
    expect(restored.every((entry) => entry.projectRevision === 12)).toBe(true);
    expect(JSON.stringify(restored)).not.toContain('"0":0');
  });

  it("notifies subscribers when logs are added or cleared", () => {
    const hub = new LogHub();
    const listener = vi.fn();
    hub.subscribe(listener);
    const entry = createLogEntry({
      event: "request",
      level: "debug",
      marker: "[SEEK]",
      requestId: "seek_01",
      scope: "scheduler",
      timestamp: "2026-08-09T12:00:00.000Z",
    });

    hub.write(entry);
    hub.clear();

    expect(listener).toHaveBeenNthCalledWith(1, entry);
    expect(listener).toHaveBeenNthCalledWith(2, undefined);
    expect(hub.getEntries()).toHaveLength(0);
  });

  it("drops writes while the hub is disabled", () => {
    const sink = { write: vi.fn() };
    const hub = new LogHub([sink]);
    const entry = createLogEntry({
      event: "request",
      level: "debug",
      marker: "[SEEK]",
      requestId: "seek_01",
      scope: "scheduler",
      timestamp: "2026-08-09T12:00:00.000Z",
    });

    hub.setEnabled(false);
    hub.write(entry);
    expect(hub.getEntries()).toHaveLength(0);
    expect(sink.write).not.toHaveBeenCalled();

    hub.setEnabled(true);
    hub.write(entry);
    expect(hub.getEntries()).toEqual([entry]);
    expect(sink.write).toHaveBeenCalledWith(entry);
  });

  it("generates schema-safe request IDs", () => {
    expect(createRequestId("seek")).toMatch(
      /^seek_[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
    );
  });
});
