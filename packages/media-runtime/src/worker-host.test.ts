import { describe, expect, it, vi } from "vitest";

import {
  MediaWorkerHost,
  WorkerClient,
  WorkerTaskRemoteError,
  type MediaWorkerInboundMessage,
  type WorkerTransport,
} from "./index";

class MessagePortWorker implements WorkerTransport {
  constructor(private readonly port: MessagePort) {
    port.start();
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    this.port.addEventListener(type, listener as EventListener);
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    this.port.removeEventListener(type, listener as EventListener);
  }

  postMessage(
    message: MediaWorkerInboundMessage,
    transfer: Transferable[] = [],
  ): void {
    this.port.postMessage(message, transfer);
  }

  terminate(): void {
    this.port.close();
  }
}

function createHostAndClient(): {
  client: WorkerClient;
  host: MediaWorkerHost;
} {
  const channel = new MessageChannel();
  channel.port1.start();
  const host = new MediaWorkerHost(channel.port1);
  const client = new WorkerClient({
    workerFactory: () => new MessagePortWorker(channel.port2),
  });
  return { client, host };
}

describe("MediaWorkerHost integration", () => {
  it("registers operations and transports progress and success", async () => {
    const { client, host } = createHostAndClient();
    const progress = vi.fn();
    host.register<{ value: number }, number, { doubled: number }>(
      "double",
      ({ value }, context) => {
        context.progress(
          { completed: 1, ratio: 0.5, stage: "compute", total: 2 },
          { doubled: value * 2 },
        );
        return { payload: value * 2 };
      },
    );

    const task = client.request<{ value: number }, number, { doubled: number }>(
      "double",
      3,
      { value: 4 },
      { requestId: "double_1" },
    );
    task.progress$.subscribe(progress);

    await expect(task.result).resolves.toBe(8);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { doubled: 8 },
        progress: expect.objectContaining({ ratio: 0.5 }),
      }),
    );
    expect(host.stats()).toMatchObject({
      activeTasks: 0,
      registeredOperations: 1,
    });
    client.dispose();
    host.dispose();
  });

  it("aborts active handlers when the client cancels", async () => {
    const { client, host } = createHostAndClient();
    let observeAbort!: (reason: unknown) => void;
    const aborted = new Promise<unknown>((resolve) => {
      observeAbort = resolve;
    });
    host.register("slow", (_payload, context) => {
      return new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            observeAbort(context.signal.reason);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const task = client.request(
      "slow",
      1,
      {},
      {
        requestId: "slow_1",
        signal: controller.signal,
      },
    );

    controller.abort("superseded");

    await expect(task.result).rejects.toMatchObject({ name: "AbortError" });
    await expect(aborted).resolves.toBe("superseded");
    expect(host.stats().activeTasks).toBe(0);
    client.dispose();
    host.dispose();
  });

  it("settles clients and aborts handlers when the host is disposed", async () => {
    const { client, host } = createHostAndClient();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    host.register("long-running", (_payload, context) => {
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      });
    });
    const task = client.request(
      "long-running",
      2,
      {},
      { requestId: "long_running_1" },
    );
    await started;

    host.dispose();

    await expect(task.result).rejects.toMatchObject({
      message: "MediaWorkerHost disposed",
      name: "AbortError",
    });
    expect(host.stats().activeTasks).toBe(0);
    client.dispose();
  });

  it("returns registered errors for unknown operations", async () => {
    const { client, host } = createHostAndClient();
    const task = client.request("missing", 1, {}, { requestId: "missing_1" });

    await expect(task.result).rejects.toMatchObject({
      code: "UNKNOWN_OPERATION",
      name: "Error",
    });
    await expect(task.result).rejects.toBeInstanceOf(WorkerTaskRemoteError);
    client.dispose();
    host.dispose();
  });

  it("transfers response buffers and records worker-side ownership", async () => {
    const { client, host } = createHostAndClient();
    let source!: ArrayBuffer;
    host.register("bytes", () => {
      source = new Uint8Array([3, 1, 4]).buffer;
      return {
        payload: { buffer: source },
        transfer: [source],
      };
    });

    const task = client.request<unknown, { buffer: ArrayBuffer }>(
      "bytes",
      5,
      {},
      { requestId: "bytes_1" },
    );

    const result = await task.result;
    expect(Array.from(new Uint8Array(result.buffer))).toEqual([3, 1, 4]);
    expect(source.byteLength).toBe(0);
    expect(host.ownership.recordFor(source)).toMatchObject({
      byteLength: 3,
      requestId: "bytes_1",
    });
    client.dispose();
    host.dispose();
  });
});
