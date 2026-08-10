import { describe, expect, it, vi } from "vitest";
import {
  LogHub,
  StructuredLogger,
  WORKER_LOG_MESSAGE_TYPE,
  WORKER_LOG_PROTOCOL_VERSION,
  createLogEntry,
} from "@web-video-editor/observability";

import {
  MEDIA_WORKER_PROTOCOL_VERSION,
  MediaWorkerProtocolError,
  ResourceLifecycleTracker,
  WorkerClient,
  WorkerTaskTimeoutError,
  WorkerTransportError,
  createWorkerError,
  parseMediaWorkerMessage,
  type MediaWorkerInboundMessage,
  type MediaWorkerMessage,
  type WorkerTransport,
} from "./index";

class FakeWorker implements WorkerTransport {
  readonly posted: MediaWorkerInboundMessage[] = [];
  terminated = false;
  onPost?: (message: MediaWorkerInboundMessage) => void;

  private readonly messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  private readonly eventListeners = new Map<
    "error" | "messageerror",
    Set<(event: Event) => void>
  >([
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      this.eventListeners.get(type)?.add(listener as (event: Event) => void);
    }
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.delete(
        listener as (event: MessageEvent<unknown>) => void,
      );
    } else {
      this.eventListeners.get(type)?.delete(listener as (event: Event) => void);
    }
  }

  postMessage(
    message: MediaWorkerInboundMessage,
    transfer: Transferable[] = [],
  ): void {
    const cloned = structuredClone(message, { transfer });
    this.posted.push(cloned);
    this.onPost?.(cloned);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    this.messageListeners.forEach((listener) => listener(event));
  }

  emitError(type: "error" | "messageerror" = "error"): void {
    const event = new Event(type);
    this.eventListeners.get(type)?.forEach((listener) => listener(event));
  }
}

function response(
  type: "cancel" | "error" | "progress" | "success" | "timeout",
  requestId: string,
  projectRevision: number,
  fields: Record<string, unknown>,
): MediaWorkerMessage {
  return {
    ...fields,
    projectRevision,
    requestId,
    type,
    version: MEDIA_WORKER_PROTOCOL_VERSION,
  } as MediaWorkerMessage;
}

describe("media worker protocol", () => {
  it("parses the complete versioned discriminated union", () => {
    const messages: MediaWorkerMessage[] = [
      {
        operation: "seek",
        payload: { timeUs: 12 },
        projectRevision: 4,
        requestId: "seek_1",
        type: "request",
        version: MEDIA_WORKER_PROTOCOL_VERSION,
      },
      response("progress", "seek_1", 4, {
        payload: { frames: 1 },
        progress: { completed: 1, ratio: 0.5, stage: "decode", total: 2 },
      }),
      response("success", "seek_1", 4, { payload: { timestampUs: 12 } }),
      response("cancel", "seek_1", 4, { reason: "superseded" }),
      response("timeout", "seek_1", 4, { timeoutMs: 1_000 }),
      response("error", "seek_1", 4, {
        error: createWorkerError(new Error("decode failed"), "DECODE_FAILED"),
      }),
    ];

    expect(messages.map(parseMediaWorkerMessage)).toEqual(messages);
  });

  it("rejects unknown versions, fields and invalid progress", () => {
    expect(() =>
      parseMediaWorkerMessage({
        operation: "seek",
        payload: {},
        projectRevision: 1,
        requestId: "seek_1",
        type: "request",
        version: 2,
      }),
    ).toThrow(MediaWorkerProtocolError);
    expect(() =>
      parseMediaWorkerMessage({
        extra: true,
        payload: {},
        projectRevision: 1,
        requestId: "seek_1",
        type: "success",
        version: 1,
      }),
    ).toThrow("invalid success");
    expect(() =>
      parseMediaWorkerMessage(
        response("progress", "seek_1", 1, {
          progress: { completed: 2, ratio: 2, stage: "decode", total: 1 },
        }),
      ),
    ).toThrow("invalid progress");
  });

  it.each([
    {
      expected: "invalid requestId",
      message: response("success", "contains spaces", 1, { payload: null }),
    },
    {
      expected: "invalid projectRevision",
      message: response("success", "valid_id", -1, { payload: null }),
    },
    {
      expected: "invalid timeout",
      message: response("timeout", "valid_id", 1, { timeoutMs: 0 }),
    },
    {
      expected: "invalid error",
      message: response("error", "valid_id", 1, {
        error: { code: "", message: 42, name: "", recoverable: "no" },
      }),
    },
  ])(
    "rejects malformed protocol boundaries: $expected",
    ({ expected, message }) => {
      expect(() => parseMediaWorkerMessage(message)).toThrow(expected);
    },
  );
});

describe("WorkerClient", () => {
  it("registers a task, forwards progress and resolves success", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient({
      createRequestId: () => "seek_1",
      workerFactory: () => worker,
    });
    const progress = vi.fn();

    const task = client.request("seek", 4, { timeUs: 12 });
    task.progress$.subscribe(progress);
    worker.emitMessage(
      response("progress", task.requestId, 4, {
        progress: { completed: 1, ratio: 0.5, stage: "decode", total: 2 },
      }),
    );
    worker.emitMessage(
      response("success", task.requestId, 4, {
        payload: { timestampUs: 12 },
      }),
    );

    await expect(task.result).resolves.toEqual({ timestampUs: 12 });
    expect(progress).toHaveBeenCalledOnce();
    expect(client.stats().activeTasks).toBe(0);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("cancels through AbortSignal and sends a protocol cancel message", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient({
      workerFactory: () => worker,
    });
    const controller = new AbortController();
    const task = client.request(
      "proxy",
      7,
      {},
      {
        requestId: "proxy_1",
        signal: controller.signal,
      },
    );

    controller.abort("user cancelled");

    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.posted.at(-1)).toEqual(
      expect.objectContaining({
        reason: "user cancelled",
        requestId: "proxy_1",
        type: "cancel",
      }),
    );
    client.dispose();
  });

  it("times out, cancels the worker operation and clears the registry", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const client = new WorkerClient({
      workerFactory: () => worker,
    });
    const task = client.request(
      "import",
      1,
      {},
      {
        requestId: "import_1",
        timeoutMs: 20,
      },
    );
    const rejection = expect(task.result).rejects.toBeInstanceOf(
      WorkerTaskTimeoutError,
    );

    await vi.advanceTimersByTimeAsync(20);

    await rejection;
    expect(worker.posted.at(-1)).toMatchObject({
      requestId: "import_1",
      timeoutMs: 20,
      type: "timeout",
    });
    expect(client.stats().activeTasks).toBe(0);
    client.dispose();
    vi.useRealTimers();
  });

  it("drops unknown and mismatched-revision responses", async () => {
    const worker = new FakeWorker();
    const hub = new LogHub();
    const client = new WorkerClient({
      logger: new StructuredLogger(hub, "worker-client"),
      workerFactory: () => worker,
    });
    const task = client.request("seek", 9, {}, { requestId: "seek_9" });

    worker.emitMessage(
      response("success", "old_seek", 9, { payload: "unknown" }),
    );
    worker.emitMessage(
      response("success", "seek_9", 8, { payload: "stale revision" }),
    );
    worker.emitMessage(
      response("success", "seek_9", 9, { payload: "current" }),
    );

    await expect(task.result).resolves.toBe("current");
    expect(client.stats().staleResponses).toBe(2);
    expect(
      hub.query({ event: "frame.dropped", marker: "[DECODE]" }),
    ).toHaveLength(2);
    client.dispose();
  });

  it("routes structured worker logs without treating them as protocol errors", async () => {
    const worker = new FakeWorker();
    const hub = new LogHub();
    const client = new WorkerClient({
      workerFactory: () => worker,
      workerLogSink: hub,
    });
    const task = client.request("import", 1, {}, { requestId: "import_log_1" });
    const entry = createLogEntry({
      event: "probe.completed",
      level: "info",
      marker: "[IMPORT]",
      requestId: "import_log_1",
      scope: "media-worker",
    });

    worker.emitMessage({
      entry,
      type: WORKER_LOG_MESSAGE_TYPE,
      version: WORKER_LOG_PROTOCOL_VERSION,
    });
    worker.emitMessage(
      response("success", "import_log_1", 1, { payload: "ok" }),
    );

    await expect(task.result).resolves.toBe("ok");
    expect(hub.getEntries()).toEqual([entry]);
    expect(client.stats().malformedMessages).toBe(0);
    client.dispose();
  });

  it("rejects a timeout response sent by the worker", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient({
      workerFactory: () => worker,
    });
    const task = client.request("export", 2, {}, { requestId: "export_1" });

    worker.emitMessage(response("timeout", "export_1", 2, { timeoutMs: 250 }));

    await expect(task.result).rejects.toMatchObject({
      name: "WorkerTaskTimeoutError",
      requestId: "export_1",
      timeoutMs: 250,
    });
    client.dispose();
  });

  it("transfers ArrayBuffer ownership and detects detached reuse", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient({
      workerFactory: () => worker,
    });
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    worker.onPost = (message) => {
      if (message.type === "request") {
        queueMicrotask(() =>
          worker.emitMessage(
            response("success", message.requestId, message.projectRevision, {
              payload: { received: true },
            }),
          ),
        );
      }
    };

    const task = client.request(
      "waveform",
      2,
      { buffer },
      { requestId: "waveform_1", transfer: [buffer] },
    );

    await expect(task.result).resolves.toEqual({ received: true });
    expect(buffer.byteLength).toBe(0);
    expect(client.ownership.recordFor(buffer)).toMatchObject({
      byteLength: 3,
      requestId: "waveform_1",
      status: "transferred",
    });
    expect(() => client.ownership.assertOwned(buffer)).toThrow(
      "ownership belongs to worker",
    );
    client.dispose();
  });

  it("rejects duplicate buffers in one transfer list before posting", async () => {
    const worker = new FakeWorker();
    const client = new WorkerClient({
      workerFactory: () => worker,
    });
    const buffer = new ArrayBuffer(4);
    const task = client.request(
      "waveform",
      1,
      { buffer },
      {
        requestId: "waveform_duplicate",
        transfer: [buffer, buffer],
      },
    );

    await expect(task.result).rejects.toBeInstanceOf(WorkerTransportError);
    expect(buffer.byteLength).toBe(4);
    expect(worker.posted).toHaveLength(0);
    client.dispose();
  });

  it("rejects active tasks after a worker error and recreates on demand", async () => {
    const workers = [new FakeWorker(), new FakeWorker()];
    let index = 0;
    const lifecycle = new ResourceLifecycleTracker();
    const client = new WorkerClient({
      lifecycle,
      workerFactory: () => workers[index++]!,
    });
    const failed = client.request("import", 1, {}, { requestId: "import_1" });

    workers[0]!.emitError();

    await expect(failed.result).rejects.toBeInstanceOf(WorkerTransportError);
    expect(workers[0]!.terminated).toBe(true);

    const recovered = client.request(
      "import",
      1,
      {},
      {
        requestId: "import_2",
      },
    );
    workers[1]!.emitMessage(
      response("success", "import_2", 1, { payload: "ok" }),
    );

    await expect(recovered.result).resolves.toBe("ok");
    expect(client.stats().workerRestarts).toBe(1);
    client.dispose();
    expect(lifecycle.snapshot().byType.worker).toMatchObject({
      active: 0,
      created: 2,
      released: 2,
    });
  });
});
