import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";

import {
  WorkerClient,
  type MediaWorkerInboundMessage,
  type WorkerTransport,
} from "./index";

const workerSource = `
  const { parentPort } = require("node:worker_threads");
  const active = new Map();

  parentPort.on("message", (message) => {
    if (message.type === "request" && message.operation === "roundtrip") {
      const bytes = new Uint8Array(message.payload.buffer);
      bytes[0] += 1;
      parentPort.postMessage({
        progress: { completed: 1, ratio: 1, stage: "worker", total: 1 },
        projectRevision: message.projectRevision,
        requestId: message.requestId,
        type: "progress",
        version: 1,
      });
      parentPort.postMessage({
        payload: { buffer: bytes.buffer },
        projectRevision: message.projectRevision,
        requestId: message.requestId,
        type: "success",
        version: 1,
      }, [bytes.buffer]);
      return;
    }

    if (message.type === "request" && message.operation === "wait") {
      active.set(message.requestId, message.payload.cancelled);
      return;
    }

    if (message.type === "cancel" || message.type === "timeout") {
      const cancelled = active.get(message.requestId);
      if (cancelled) {
        Atomics.store(new Int32Array(cancelled), 0, 1);
        Atomics.notify(new Int32Array(cancelled), 0);
        active.delete(message.requestId);
      }
    }
  });
`;

class NodeWorkerTransport implements WorkerTransport {
  private readonly listeners = new Map<
    EventListener,
    (...args: unknown[]) => void
  >();

  constructor(private readonly worker: Worker) {}

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    const wrapped =
      type === "message"
        ? (data: unknown) =>
            (listener as (event: MessageEvent<unknown>) => void)(
              new MessageEvent("message", { data }),
            )
        : () => (listener as (event: Event) => void)(new Event(type));
    this.listeners.set(listener as EventListener, wrapped);
    this.worker.on(type, wrapped);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    const wrapped = this.listeners.get(listener as EventListener);
    if (wrapped) {
      this.worker.off(type, wrapped);
      this.listeners.delete(listener as EventListener);
    }
  }

  postMessage(
    message: MediaWorkerInboundMessage,
    transfer: Transferable[] = [],
  ): void {
    if (transfer.some((item) => !(item instanceof ArrayBuffer))) {
      throw new TypeError("Node test transport only supports ArrayBuffer");
    }
    this.worker.postMessage(message, transfer as ArrayBuffer[]);
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("Timed out waiting for worker state");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("WorkerClient worker_threads integration", () => {
  it("transfers detached buffers, progress, and cancellation across a Worker", async () => {
    const worker = new Worker(workerSource, { eval: true });
    const client = new WorkerClient({
      workerFactory: () => new NodeWorkerTransport(worker),
    });
    const source = new Uint8Array([4, 2]).buffer;
    const progress = vi.fn();
    const roundtrip = client.request<
      { buffer: ArrayBuffer },
      { buffer: ArrayBuffer }
    >(
      "roundtrip",
      1,
      { buffer: source },
      { requestId: "roundtrip_1", transfer: [source] },
    );
    roundtrip.progress$.subscribe(progress);

    const result = await roundtrip.result;

    expect(source.byteLength).toBe(0);
    expect(Array.from(new Uint8Array(result.buffer))).toEqual([5, 2]);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        progress: expect.objectContaining({ stage: "worker" }),
      }),
    );

    const cancelled = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const controller = new AbortController();
    const waiting = client.request(
      "wait",
      1,
      { cancelled },
      { requestId: "wait_1", signal: controller.signal },
    );
    controller.abort("integration cancelled");

    await expect(waiting.result).rejects.toMatchObject({ name: "AbortError" });
    await waitUntil(() => Atomics.load(new Int32Array(cancelled), 0) === 1);
    client.dispose();
  });
});
