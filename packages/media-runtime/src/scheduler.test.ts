import { LogHub, StructuredLogger } from "@web-video-editor/observability";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import {
  BoundedTaskQueue,
  MediabunnyDecoderQueueAdapter,
  MEDIA_WORKER_PROTOCOL_VERSION,
  QueueBackpressureError,
  QueueWatermarkGate,
  WorkerClient,
  createSeekStream,
  createWorkerSeekStream,
  type MediaWorkerInboundMessage,
  type WorkerTransport,
} from "./index";

class SchedulerWorker implements WorkerTransport {
  readonly posted: MediaWorkerInboundMessage[] = [];
  private readonly messages = new Set<(event: MessageEvent<unknown>) => void>();

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "message") {
      this.messages.add(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  removeEventListener(
    type: "message" | "error" | "messageerror",
    listener:
      ((event: Event) => void) | ((event: MessageEvent<unknown>) => void),
  ): void {
    if (type === "message") {
      this.messages.delete(listener as (event: MessageEvent<unknown>) => void);
    }
  }

  postMessage(message: MediaWorkerInboundMessage): void {
    this.posted.push(structuredClone(message));
  }

  terminate(): void {}

  emit(data: unknown): void {
    const event = new MessageEvent("message", { data });
    this.messages.forEach((listener) => listener(event));
  }
}

describe("RxJS media scheduling", () => {
  it("uses switchMap cancellation so only the latest seek is emitted", async () => {
    const requests = new Subject<{ projectRevision: number; timeUs: number }>();
    const resolutions = new Map<number, (value: number) => void>();
    const cancelled: number[] = [];
    const results: number[] = [];
    const stream = createSeekStream(requests, (request, signal) => {
      return new Promise<number>((resolve, reject) => {
        resolutions.set(request.timeUs, resolve);
        signal.addEventListener("abort", () => {
          cancelled.push(request.timeUs);
          reject(new DOMException("superseded", "AbortError"));
        });
      });
    });
    const subscription = stream.subscribe((value) => results.push(value));

    requests.next({ projectRevision: 1, timeUs: 10 });
    requests.next({ projectRevision: 1, timeUs: 20 });
    resolutions.get(10)?.(10);
    resolutions.get(20)?.(20);
    await Promise.resolve();

    expect(cancelled).toEqual([10]);
    expect(results).toEqual([20]);
    subscription.unsubscribe();
  });

  it("cancels the superseded Worker seek and emits only the current revision", async () => {
    const worker = new SchedulerWorker();
    const client = new WorkerClient({ workerFactory: () => worker });
    const requests = new Subject<{
      payload: { timeUs: number };
      projectRevision: number;
      requestId: string;
    }>();
    const results: number[] = [];
    const subscription = createWorkerSeekStream<
      { timeUs: number },
      { timeUs: number }
    >(requests, client).subscribe((result) => results.push(result.timeUs));

    requests.next({
      payload: { timeUs: 10 },
      projectRevision: 1,
      requestId: "seek_10",
    });
    requests.next({
      payload: { timeUs: 20 },
      projectRevision: 2,
      requestId: "seek_20",
    });
    expect(worker.posted).toContainEqual(
      expect.objectContaining({ requestId: "seek_10", type: "cancel" }),
    );
    worker.emit({
      payload: { timeUs: 10 },
      projectRevision: 1,
      requestId: "seek_10",
      type: "success",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });
    worker.emit({
      payload: { timeUs: 20 },
      projectRevision: 2,
      requestId: "seek_20",
      type: "success",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });
    await Promise.resolve();

    expect(results).toEqual([20]);
    subscription.unsubscribe();
    client.dispose();
  });

  it("enforces concurrency and queued-task high watermarks", async () => {
    const worker = new SchedulerWorker();
    const client = new WorkerClient({ workerFactory: () => worker });
    const hub = new LogHub();
    const queue = new BoundedTaskQueue(client, {
      concurrency: 1,
      highWatermark: 1,
      logger: new StructuredLogger(hub, "media-scheduler"),
      operation: "proxy",
    });
    const events: string[] = [];
    queue.events$.subscribe((event) => events.push(event.type));

    const first = queue.schedule(
      1,
      { assetId: "a" },
      {
        requestId: "proxy_1",
      },
    );
    const second = queue.schedule(
      1,
      { assetId: "b" },
      {
        requestId: "proxy_2",
      },
    );
    const secondResult = second.result.catch((error: unknown) => error);

    expect(queue.stats()).toEqual({
      active: 1,
      activePeak: 1,
      backpressureCount: 0,
      concurrency: 1,
      highWatermark: 1,
      queued: 1,
      queuedPeak: 1,
    });
    expect(() =>
      queue.schedule(1, { assetId: "c" }, { requestId: "proxy_3" }),
    ).toThrow(QueueBackpressureError);

    second.cancel("no longer needed");
    expect(await secondResult).toMatchObject({ name: "AbortError" });
    worker.emit({
      payload: "proxy-a",
      projectRevision: 1,
      requestId: "proxy_1",
      type: "success",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });

    await expect(first.result).resolves.toBe("proxy-a");
    await Promise.resolve();
    expect(queue.stats()).toEqual({
      active: 0,
      activePeak: 1,
      backpressureCount: 1,
      concurrency: 1,
      highWatermark: 1,
      queued: 0,
      queuedPeak: 1,
    });
    expect(events).toEqual(
      expect.arrayContaining([
        "queued",
        "started",
        "backpressure",
        "cancelled",
        "completed",
      ]),
    );
    expect(hub.query({ event: "queue.state", marker: "[PROXY]" }).length).toBe(
      6,
    );
    expect(
      hub.query({ event: "generation.completed", marker: "[PROXY]" }),
    ).toHaveLength(1);
    expect(
      hub.query({ event: "generation.cancelled", marker: "[PROXY]" }),
    ).toHaveLength(1);
    queue.dispose();
    client.dispose();
  });

  it("combines per-task and aggregate progress", async () => {
    const worker = new SchedulerWorker();
    const client = new WorkerClient({ workerFactory: () => worker });
    const queue = new BoundedTaskQueue(client, {
      concurrency: 2,
      highWatermark: 2,
      operation: "import",
    });
    const taskProgress = vi.fn();
    const aggregateProgress = vi.fn();
    queue.events$.subscribe((event) => {
      if (event.type === "progress") {
        aggregateProgress(event.progress);
      }
    });
    const task = queue.schedule(3, {}, { requestId: "import_1" });
    task.progress$.subscribe(taskProgress);

    worker.emit({
      progress: {
        completed: 5,
        ratio: 0.5,
        stage: "read",
        total: 10,
      },
      projectRevision: 3,
      requestId: "import_1",
      type: "progress",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });
    worker.emit({
      payload: "done",
      projectRevision: 3,
      requestId: "import_1",
      type: "success",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });

    await expect(task.result).resolves.toBe("done");
    expect(taskProgress).toHaveBeenCalledOnce();
    expect(aggregateProgress).toHaveBeenCalledWith(
      expect.objectContaining({ ratio: 0.5, stage: "read" }),
    );
    queue.dispose();
    client.dispose();
  });

  it("settles active and queued tasks when the queue is disposed", async () => {
    const worker = new SchedulerWorker();
    const client = new WorkerClient({ workerFactory: () => worker });
    const queue = new BoundedTaskQueue(client, {
      concurrency: 1,
      highWatermark: 2,
      operation: "proxy",
    });
    const active = queue.schedule(1, {}, { requestId: "proxy_active" });
    const queued = queue.schedule(1, {}, { requestId: "proxy_queued" });
    const activeRejection = active.result.catch((error: unknown) => error);
    const queuedRejection = queued.result.catch((error: unknown) => error);

    queue.dispose();

    expect(await activeRejection).toMatchObject({ name: "AbortError" });
    expect(await queuedRejection).toMatchObject({ name: "AbortError" });
    expect(client.stats().activeTasks).toBe(0);
    client.dispose();
  });

  it("waits for codec queue low watermarks and supports cancellation", async () => {
    const source = { queueSize: 4 };
    const gate = new QueueWatermarkGate(source, 4, 1, 1);
    const waiting = gate.wait();
    setTimeout(() => {
      source.queueSize = 1;
    }, 2);

    await expect(waiting).resolves.toBe(true);
    source.queueSize = 0;
    await expect(gate.wait()).resolves.toBe(false);

    source.queueSize = 4;
    const controller = new AbortController();
    const cancelledWait = gate.wait(controller.signal);
    controller.abort("decode stopped");
    await expect(cancelledWait).rejects.toMatchObject({ name: "AbortError" });
  });

  it("interrupts a long watermark poll immediately on abort", async () => {
    const source = { queueSize: 4 };
    const gate = new QueueWatermarkGate(source, 4, 1, 60_000);
    const controller = new AbortController();
    const waiting = gate.wait(controller.signal);

    controller.abort("decoder closed");

    await expect(waiting).rejects.toMatchObject({
      message: "decoder closed",
      name: "AbortError",
    });
  });

  it("bounds the Mediabunny application decoder queue without inventing internal queue sizes", async () => {
    const releases: Array<() => void> = [];
    const adapter = new MediabunnyDecoderQueueAdapter("VideoDecoder", {
      concurrency: 1,
      highWatermark: 1,
      overflowPolicy: "replace-oldest",
    });
    const run = (value: number) => () =>
      new Promise<number>((resolve) => {
        releases.push(() => resolve(value));
      });

    const first = adapter.schedule("decode-1", run(1));
    const second = adapter.schedule("decode-2", run(2));
    const secondError = second.result.catch((error: unknown) => error);
    const third = adapter.schedule("decode-3", run(3));

    expect(await secondError).toMatchObject({ name: "AbortError" });
    expect(adapter.stats()).toMatchObject({
      applicationQueue: {
        active: 1,
        activePeak: 1,
        backpressureCount: 1,
        concurrency: 1,
        highWatermark: 1,
        queued: 1,
        queuedPeak: 1,
      },
      codec: "VideoDecoder",
      implementation: "mediabunny",
      internalQueue: {
        available: false,
        highWatermark: null,
        peak: null,
        queueSize: null,
      },
    });

    releases.shift()?.();
    await expect(first.result).resolves.toBe(1);
    releases.shift()?.();
    await expect(third.result).resolves.toBe(3);
    expect(adapter.stats().applicationQueue).toMatchObject({
      active: 0,
      activePeak: 1,
      backpressureCount: 1,
      queued: 0,
      queuedPeak: 1,
    });
    adapter.dispose();
  });

  it("does not free decoder concurrency until an aborted active operation settles", async () => {
    const started: string[] = [];
    let settleActive!: () => void;
    const adapter = new MediabunnyDecoderQueueAdapter("AudioDecoder", {
      concurrency: 1,
      highWatermark: 1,
    });
    const first = adapter.schedule("audio-1", async () => {
      started.push("audio-1");
      await new Promise<void>((resolve) => {
        settleActive = resolve;
      });
    });
    const firstError = first.result.catch((error: unknown) => error);
    const second = adapter.schedule("audio-2", async () => {
      started.push("audio-2");
    });
    const secondError = second.result.catch((error: unknown) => error);

    first.cancel("superseded");
    expect(await firstError).toMatchObject({ name: "AbortError" });
    expect(started).toEqual(["audio-1"]);
    expect(adapter.stats().applicationQueue).toMatchObject({
      active: 1,
      queued: 1,
    });

    second.cancel("Seek superseded");
    expect(await secondError).toMatchObject({ name: "AbortError" });
    const third = adapter.schedule("audio-3", async () => {
      started.push("audio-3");
    });
    settleActive();
    await expect(third.result).resolves.toBeUndefined();
    expect(started).toEqual(["audio-1", "audio-3"]);
    expect(adapter.stats().applicationQueue.backpressureCount).toBe(1);
    adapter.dispose();
  });
});
