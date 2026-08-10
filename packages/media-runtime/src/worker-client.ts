import {
  WORKER_LOG_MESSAGE_TYPE,
  createRequestId,
  receiveWorkerLog,
  type LogSink,
  type StructuredLogger,
} from "@web-video-editor/observability";
import { Observable, Subject } from "rxjs";

import { ResourceLifecycleTracker, type ResourceLease } from "./lifecycle";
import {
  MEDIA_WORKER_PROTOCOL_VERSION,
  MediaWorkerProtocolError,
  parseMediaWorkerMessage,
  type MediaWorkerCancel,
  type MediaWorkerInboundMessage,
  type MediaWorkerOutboundMessage,
  type MediaWorkerProgress,
  type MediaWorkerRequest,
  type MediaWorkerTimeout,
} from "./protocol";
import { TransferOwnershipLedger } from "./transfer";

export type WorkerTransport = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  postMessage(
    message: MediaWorkerInboundMessage,
    transfer?: Transferable[],
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "error" | "messageerror",
    listener: (event: Event) => void,
  ): void;
  terminate(): void;
};

export class WorkerTaskTimeoutError extends Error {
  constructor(
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(`Worker task ${requestId} timed out after ${timeoutMs} ms`);
    this.name = "WorkerTaskTimeoutError";
  }
}

export class WorkerTaskRemoteError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  override readonly cause?: unknown;

  constructor(message: MediaWorkerOutboundMessage & { type: "error" }) {
    super(message.error.message);
    this.name = message.error.name || "WorkerTaskRemoteError";
    this.code = message.error.code;
    this.recoverable = message.error.recoverable;
    this.cause = message.error.cause;
  }
}

export class WorkerTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkerTransportError";
  }
}

export type WorkerTaskHandle<TResult = unknown, TProgress = unknown> = {
  cancel(reason?: string): void;
  progress$: Observable<MediaWorkerProgress<TProgress>>;
  requestId: string;
  result: Promise<TResult>;
};

export type WorkerTaskOptions = {
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  transfer?: readonly Transferable[];
};

export type WorkerClientStats = {
  activeTasks: number;
  malformedMessages: number;
  staleResponses: number;
  workerRestarts: number;
};

export type WorkerClientOptions = {
  createRequestId?: (operation: string) => string;
  defaultTimeoutMs?: number;
  lifecycle?: ResourceLifecycleTracker;
  logger?: StructuredLogger;
  workerLogSink?: LogSink;
  workerFactory: () => WorkerTransport;
};

type PendingTask = {
  abortListener?: () => void;
  progress: Subject<MediaWorkerProgress>;
  projectRevision: number;
  reject: (reason: unknown) => void;
  resolve: (value: unknown) => void;
  signal?: AbortSignal;
  timer?: ReturnType<typeof setTimeout>;
};

function abortError(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

function eventError(event: Event): Error {
  if (
    typeof ErrorEvent !== "undefined" &&
    event instanceof ErrorEvent &&
    event.error !== undefined
  ) {
    return event.error instanceof Error
      ? event.error
      : new Error(String(event.error));
  }
  return new Error(`${event.type} received from media worker`);
}

export class WorkerClient {
  readonly ownership = new TransferOwnershipLedger();

  private readonly tasks = new Map<string, PendingTask>();
  private readonly lifecycle: ResourceLifecycleTracker;
  private readonly ownsLifecycle: boolean;
  private readonly createId: (operation: string) => string;
  private readonly defaultTimeoutMs: number;
  private worker?: WorkerTransport;
  private workerLease?: ResourceLease;
  private disposed = false;
  private malformedMessages = 0;
  private staleResponses = 0;
  private workerRestarts = 0;

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (
      this.options.workerLogSink &&
      typeof event.data === "object" &&
      event.data !== null &&
      "type" in event.data &&
      event.data.type === WORKER_LOG_MESSAGE_TYPE
    ) {
      try {
        receiveWorkerLog(event.data, this.options.workerLogSink);
      } catch {
        this.malformedMessages += 1;
      }
      return;
    }

    let message: MediaWorkerOutboundMessage;
    try {
      const parsed = parseMediaWorkerMessage(event.data);
      if (parsed.type === "request") {
        throw new MediaWorkerProtocolError(
          "worker sent a request to the client",
        );
      }
      message = parsed;
    } catch (error) {
      this.malformedMessages += 1;
      this.options.logger?.log({
        error,
        event: "failed",
        input: event.data,
        level: "warn",
        marker: "[DECODE]",
      });
      return;
    }

    const task = this.tasks.get(message.requestId);
    if (!task || task.projectRevision !== message.projectRevision) {
      this.staleResponses += 1;
      this.options.logger?.log({
        event: "frame.dropped",
        input: {
          incomingRevision: message.projectRevision,
          responseType: message.type,
        },
        level: "debug",
        marker: "[DECODE]",
        output: {
          activeRevision: task?.projectRevision,
          reason: task ? "project-revision-mismatch" : "unknown-request",
        },
        projectRevision: message.projectRevision,
        requestId: message.requestId,
      });
      return;
    }

    switch (message.type) {
      case "progress":
        task.progress.next(message);
        break;
      case "success":
        this.settle(message.requestId, "resolve", message.payload);
        break;
      case "cancel":
        this.settle(message.requestId, "reject", abortError(message.reason));
        break;
      case "timeout":
        this.settle(
          message.requestId,
          "reject",
          new WorkerTaskTimeoutError(message.requestId, message.timeoutMs),
        );
        break;
      case "error":
        this.settle(
          message.requestId,
          "reject",
          new WorkerTaskRemoteError(message),
        );
        break;
    }
  };

  private readonly onWorkerFailure = (event: Event): void => {
    this.failWorker(
      new WorkerTransportError("Media worker failed", {
        cause: eventError(event),
      }),
    );
  };

  constructor(private readonly options: WorkerClientOptions) {
    this.createId =
      options.createRequestId ?? ((operation) => createRequestId(operation));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.lifecycle = options.lifecycle ?? new ResourceLifecycleTracker();
    this.ownsLifecycle = options.lifecycle === undefined;
  }

  request<TPayload, TResult = unknown, TProgress = unknown>(
    operation: string,
    projectRevision: number,
    payload: TPayload,
    options: WorkerTaskOptions = {},
  ): WorkerTaskHandle<TResult, TProgress> {
    if (this.disposed) {
      throw new Error("WorkerClient is disposed");
    }
    if (!Number.isSafeInteger(projectRevision) || projectRevision < 0) {
      throw new RangeError(
        "projectRevision must be a non-negative safe integer",
      );
    }
    if (options.signal?.aborted) {
      const requestId = options.requestId ?? this.createId(operation);
      return {
        cancel: () => undefined,
        progress$: new Observable((subscriber) => subscriber.complete()),
        requestId,
        result: Promise.reject(
          abortError(String(options.signal.reason ?? "Task aborted")),
        ),
      };
    }

    const requestId = options.requestId ?? this.createId(operation);
    if (this.tasks.has(requestId)) {
      throw new Error(`Worker task "${requestId}" is already registered`);
    }
    const progress = new Subject<MediaWorkerProgress>();
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolvePromise = (value) => resolve(value as TResult);
      rejectPromise = reject;
    });
    const task: PendingTask = {
      progress,
      projectRevision,
      reject: rejectPromise,
      resolve: resolvePromise,
      signal: options.signal,
    };
    this.tasks.set(requestId, task);

    if (options.signal) {
      task.abortListener = () =>
        this.cancel(
          requestId,
          String(options.signal?.reason ?? "Task aborted"),
        );
      options.signal.addEventListener("abort", task.abortListener, {
        once: true,
      });
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      this.settle(
        requestId,
        "reject",
        new RangeError("timeoutMs must be a positive finite number"),
      );
    } else {
      task.timer = setTimeout(() => {
        this.postTimeout(requestId, projectRevision, timeoutMs);
        this.settle(
          requestId,
          "reject",
          new WorkerTaskTimeoutError(requestId, timeoutMs),
        );
      }, timeoutMs);
    }

    if (this.tasks.has(requestId)) {
      const message: MediaWorkerRequest<TPayload> = {
        operation,
        payload,
        projectRevision,
        requestId,
        type: "request",
        version: MEDIA_WORKER_PROTOCOL_VERSION,
      };
      try {
        const worker = this.ensureWorker();
        const transfer = [...(options.transfer ?? [])];
        const pending = this.ownership.begin(requestId, transfer);
        worker.postMessage(message, transfer);
        this.ownership.complete(requestId, pending);
      } catch (error) {
        this.settle(
          requestId,
          "reject",
          new WorkerTransportError(`Failed to post worker task ${requestId}`, {
            cause: error,
          }),
        );
      }
    }

    return {
      cancel: (reason = "Task cancelled") => this.cancel(requestId, reason),
      progress$: progress.asObservable() as Observable<
        MediaWorkerProgress<TProgress>
      >,
      requestId,
      result,
    };
  }

  cancel(requestId: string, reason = "Task cancelled"): void {
    const task = this.tasks.get(requestId);
    if (!task) {
      return;
    }
    this.postCancel(requestId, task.projectRevision, reason);
    this.settle(requestId, "reject", abortError(reason));
  }

  stats(): WorkerClientStats {
    return {
      activeTasks: this.tasks.size,
      malformedMessages: this.malformedMessages,
      staleResponses: this.staleResponses,
      workerRestarts: this.workerRestarts,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const requestId of [...this.tasks.keys()]) {
      this.settle(requestId, "reject", abortError("WorkerClient disposed"));
    }
    this.releaseWorker();
    if (this.ownsLifecycle) {
      this.lifecycle.assertReleased();
    }
  }

  private ensureWorker(): WorkerTransport {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.options.workerFactory();
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onWorkerFailure);
    worker.addEventListener("messageerror", this.onWorkerFailure);
    this.worker = worker;
    this.workerLease = this.lifecycle.trackWorker(worker);
    return worker;
  }

  private postCancel(
    requestId: string,
    projectRevision: number,
    reason: string,
  ): void {
    if (!this.worker) {
      return;
    }
    const message: MediaWorkerCancel = {
      projectRevision,
      reason,
      requestId,
      type: "cancel",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    };
    try {
      this.worker.postMessage(message);
    } catch (error) {
      this.failWorker(
        new WorkerTransportError("Failed to cancel media worker task", {
          cause: error,
        }),
      );
    }
  }

  private postTimeout(
    requestId: string,
    projectRevision: number,
    timeoutMs: number,
  ): void {
    if (!this.worker) {
      return;
    }
    const message: MediaWorkerTimeout = {
      projectRevision,
      requestId,
      timeoutMs,
      type: "timeout",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    };
    try {
      this.worker.postMessage(message);
    } catch (error) {
      this.failWorker(
        new WorkerTransportError("Failed to time out media worker task", {
          cause: error,
        }),
      );
    }
  }

  private settle(
    requestId: string,
    outcome: "reject" | "resolve",
    value: unknown,
  ): void {
    const task = this.tasks.get(requestId);
    if (!task) {
      return;
    }
    this.tasks.delete(requestId);
    if (task.timer) {
      clearTimeout(task.timer);
    }
    if (task.signal && task.abortListener) {
      task.signal.removeEventListener("abort", task.abortListener);
    }
    task.progress.complete();
    if (outcome === "resolve") {
      task.resolve(value);
    } else {
      task.reject(value);
    }
  }

  private failWorker(error: WorkerTransportError): void {
    if (!this.worker) {
      return;
    }
    this.workerRestarts += 1;
    this.releaseWorker();
    for (const requestId of [...this.tasks.keys()]) {
      this.settle(requestId, "reject", error);
    }
  }

  private releaseWorker(): void {
    const worker = this.worker;
    if (!worker) {
      return;
    }
    worker.removeEventListener("message", this.onMessage);
    worker.removeEventListener("error", this.onWorkerFailure);
    worker.removeEventListener("messageerror", this.onWorkerFailure);
    this.worker = undefined;
    const lease = this.workerLease;
    this.workerLease = undefined;
    lease?.release();
  }
}
