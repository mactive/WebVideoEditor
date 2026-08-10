import type { StructuredLogger } from "@web-video-editor/observability";
import { EMPTY, Observable, Subject, Subscription, defer, from } from "rxjs";
import { catchError, finalize, mergeMap, switchMap, tap } from "rxjs/operators";

import {
  WorkerClient,
  type WorkerTaskHandle,
  type WorkerTaskOptions,
} from "./worker-client";
import type { MediaWorkerProgress } from "./protocol";

export type RevisionedRequest = {
  projectRevision: number;
};

export function createSeekStream<TRequest extends RevisionedRequest, TResult>(
  requests$: Observable<TRequest>,
  execute: (request: TRequest, signal: AbortSignal) => Promise<TResult>,
): Observable<TResult> {
  return requests$.pipe(
    switchMap(
      (request) =>
        new Observable<TResult>((subscriber) => {
          const controller = new AbortController();
          let settled = false;
          void execute(request, controller.signal).then(
            (result) => {
              settled = true;
              subscriber.next(result);
              subscriber.complete();
            },
            (error: unknown) => {
              settled = true;
              subscriber.error(error);
            },
          );
          return () => {
            if (!settled) {
              controller.abort("Seek superseded");
            }
          };
        }),
    ),
  );
}

export type WorkerSeekRequest<TPayload = unknown> = RevisionedRequest & {
  payload: TPayload;
  requestId?: string;
  timeoutMs?: number;
  transfer?: readonly Transferable[];
};

export function createWorkerSeekStream<TPayload, TResult, TProgress = unknown>(
  requests$: Observable<WorkerSeekRequest<TPayload>>,
  client: WorkerClient,
  operation = "seek",
): Observable<TResult> {
  return createSeekStream(
    requests$,
    (request, signal) =>
      client.request<TPayload, TResult, TProgress>(
        operation,
        request.projectRevision,
        request.payload,
        {
          requestId: request.requestId,
          signal,
          timeoutMs: request.timeoutMs,
          transfer: request.transfer,
        },
      ).result,
  );
}

type QueueEventContext = {
  active: number;
  concurrency: number;
  highWatermark: number;
  operation: string;
  queued: number;
  requestId: string;
};

export type QueueEvent = QueueEventContext &
  (
    | {
        type: "queued" | "started";
      }
    | {
        progress: MediaWorkerProgress["progress"];
        type: "progress";
      }
    | {
        type: "cancelled" | "completed" | "failed";
      }
    | {
        type: "backpressure";
      }
  );

export class QueueBackpressureError extends Error {
  constructor(
    readonly operation: string,
    readonly highWatermark: number,
  ) {
    super(
      `${operation} queue reached its high watermark (${highWatermark} waiting tasks)`,
    );
    this.name = "QueueBackpressureError";
  }
}

export type ScheduledTaskHandle<TResult = unknown, TProgress = unknown> = {
  cancel(reason?: string): void;
  progress$: Observable<MediaWorkerProgress<TProgress>>;
  requestId: string;
  result: Promise<TResult>;
};

export type BoundedTaskQueueOptions = {
  concurrency: number;
  highWatermark: number;
  logger?: StructuredLogger;
  marker?: "[EXPORT]" | "[IMPORT]" | "[PROXY]";
  operation: string;
};

export type QueueStats = {
  active: number;
  activePeak: number;
  backpressureCount: number;
  concurrency: number;
  highWatermark: number;
  queued: number;
  queuedPeak: number;
};

type QueueJob = {
  controller: AbortController;
  externalAbort?: () => void;
  externalSignal?: AbortSignal;
  options: WorkerTaskOptions;
  payload: unknown;
  progress: Subject<MediaWorkerProgress>;
  projectRevision: number;
  reject: (reason: unknown) => void;
  requestId: string;
  resolve: (value: unknown) => void;
  settled: boolean;
  workerTask?: WorkerTaskHandle;
};

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function cancelled(reason: string): DOMException {
  return new DOMException(reason, "AbortError");
}

export class BoundedTaskQueue {
  readonly events$: Observable<QueueEvent>;

  private readonly jobs = new Subject<QueueJob>();
  private readonly registeredJobs = new Set<QueueJob>();
  private readonly events = new Subject<QueueEvent>();
  private readonly subscription: Subscription;
  private active = 0;
  private activePeak = 0;
  private backpressureCount = 0;
  private queued = 0;
  private queuedPeak = 0;
  private disposed = false;

  constructor(
    private readonly client: WorkerClient,
    readonly options: BoundedTaskQueueOptions,
  ) {
    validateLimit(options.concurrency, "concurrency");
    validateLimit(options.highWatermark, "highWatermark");
    this.events$ = this.events.asObservable();
    this.subscription = this.jobs
      .pipe(mergeMap((job) => this.run(job), options.concurrency))
      .subscribe();
  }

  schedule<TPayload, TResult = unknown, TProgress = unknown>(
    projectRevision: number,
    payload: TPayload,
    options: WorkerTaskOptions & { requestId: string },
  ): ScheduledTaskHandle<TResult, TProgress> {
    if (this.disposed) {
      throw new Error(`${this.options.operation} queue is disposed`);
    }
    if (this.queued >= this.options.highWatermark) {
      this.backpressureCount += 1;
      const event = {
        active: this.active,
        concurrency: this.options.concurrency,
        highWatermark: this.options.highWatermark,
        operation: this.options.operation,
        queued: this.queued,
        requestId: options.requestId,
        type: "backpressure",
      } as const;
      this.events.next(event);
      this.logQueueState("backpressure", options.requestId);
      this.logBackpressure(event);
      throw new QueueBackpressureError(
        this.options.operation,
        this.options.highWatermark,
      );
    }

    const controller = new AbortController();
    const progress = new Subject<MediaWorkerProgress>();
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolvePromise = (value) => resolve(value as TResult);
      rejectPromise = reject;
    });
    const job: QueueJob = {
      controller,
      options,
      payload,
      progress,
      projectRevision,
      reject: rejectPromise,
      requestId: options.requestId,
      resolve: resolvePromise,
      settled: false,
    };
    this.registeredJobs.add(job);

    if (options.signal) {
      job.externalSignal = options.signal;
      job.externalAbort = () =>
        this.cancelJob(job, String(options.signal?.reason ?? "Task cancelled"));
      if (options.signal.aborted) {
        job.externalAbort();
      } else {
        options.signal.addEventListener("abort", job.externalAbort, {
          once: true,
        });
      }
    }

    if (!job.settled) {
      this.queued += 1;
      this.queuedPeak = Math.max(this.queuedPeak, this.queued);
      this.events.next({ ...this.context(job), type: "queued" });
      this.logQueueState("queued", job.requestId);
      this.jobs.next(job);
    }

    return {
      cancel: (reason = "Task cancelled") => this.cancelJob(job, reason),
      progress$: progress.asObservable() as Observable<
        MediaWorkerProgress<TProgress>
      >,
      requestId: job.requestId,
      result,
    };
  }

  stats(): QueueStats {
    return {
      active: this.active,
      activePeak: this.activePeak,
      backpressureCount: this.backpressureCount,
      concurrency: this.options.concurrency,
      highWatermark: this.options.highWatermark,
      queued: this.queued,
      queuedPeak: this.queuedPeak,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const job of [...this.registeredJobs]) {
      if (job.workerTask) {
        job.workerTask.cancel("Task queue disposed");
        this.finish(job, "cancelled", cancelled("Task queue disposed"));
      } else {
        this.cancelJob(job, "Task queue disposed");
      }
    }
    this.jobs.complete();
    this.subscription.unsubscribe();
    this.events.complete();
  }

  private run(job: QueueJob): Observable<unknown> {
    return defer(() => {
      if (job.settled) {
        return EMPTY;
      }
      this.queued -= 1;
      this.active += 1;
      this.activePeak = Math.max(this.activePeak, this.active);
      this.events.next({ ...this.context(job), type: "started" });
      this.logQueueState("started", job.requestId);

      try {
        job.workerTask = this.client.request(
          this.options.operation,
          job.projectRevision,
          job.payload,
          {
            ...job.options,
            signal: job.controller.signal,
          },
        );
      } catch (error) {
        this.finish(job, "failed", error);
        this.active -= 1;
        this.logQueueState("settled", job.requestId);
        return EMPTY;
      }

      const progressSubscription = job.workerTask.progress$.subscribe(
        (progress) => {
          job.progress.next(progress);
          this.events.next({
            ...this.context(job),
            progress: progress.progress,
            type: "progress",
          });
          this.logProgress(job, progress.progress);
        },
      );

      return from(job.workerTask.result).pipe(
        tap((value) => this.finish(job, "completed", value)),
        catchError((error: unknown) => {
          this.finish(
            job,
            error instanceof DOMException && error.name === "AbortError"
              ? "cancelled"
              : "failed",
            error,
          );
          return EMPTY;
        }),
        finalize(() => {
          progressSubscription.unsubscribe();
          this.active -= 1;
          this.cleanup(job);
          this.logQueueState("settled", job.requestId);
        }),
      );
    });
  }

  private cancelJob(job: QueueJob, reason: string): void {
    if (job.settled) {
      return;
    }
    if (job.workerTask) {
      job.controller.abort(reason);
      return;
    }
    job.settled = true;
    this.queued = Math.max(0, this.queued - 1);
    job.reject(cancelled(reason));
    job.progress.complete();
    this.events.next({ ...this.context(job), type: "cancelled" });
    this.logFinished(job, "cancelled", cancelled(reason));
    this.cleanup(job);
    this.logQueueState("cancelled", job.requestId);
  }

  private finish(
    job: QueueJob,
    type: "cancelled" | "completed" | "failed",
    value: unknown,
  ): void {
    if (job.settled) {
      return;
    }
    job.settled = true;
    if (type === "completed") {
      job.resolve(value);
    } else {
      job.reject(value);
    }
    job.progress.complete();
    this.events.next({ ...this.context(job), type });
    this.logFinished(job, type, value);
  }

  private cleanup(job: QueueJob): void {
    this.registeredJobs.delete(job);
    if (job.externalSignal && job.externalAbort) {
      job.externalSignal.removeEventListener("abort", job.externalAbort);
    }
  }

  private context(job: QueueJob): {
    active: number;
    concurrency: number;
    highWatermark: number;
    operation: string;
    queued: number;
    requestId: string;
  } {
    return {
      active: this.active,
      concurrency: this.options.concurrency,
      highWatermark: this.options.highWatermark,
      operation: this.options.operation,
      queued: this.queued,
      requestId: job.requestId,
    };
  }

  private logBackpressure(
    event: Extract<QueueEvent, { type: "backpressure" }>,
  ): void {
    const output = {
      active: event.active,
      highWatermark: event.highWatermark,
      operation: event.operation,
      queued: event.queued,
    };
    const marker =
      this.options.marker ??
      (event.operation.includes("probe") || event.operation === "import"
        ? "[IMPORT]"
        : event.operation.includes("export")
          ? "[EXPORT]"
          : "[PROXY]");
    if (marker === "[IMPORT]") {
      this.options.logger?.log({
        event: "backpressure",
        level: "debug",
        marker: "[DEMUX]",
        output,
        requestId: event.requestId,
      });
    } else if (marker === "[EXPORT]") {
      this.options.logger?.log({
        event: "backpressure",
        level: "warn",
        marker,
        output,
        requestId: event.requestId,
      });
    }
  }

  private logQueueState(transition: string, requestId: string): void {
    const marker = this.logMarker();
    this.options.logger?.log({
      event: "queue.state",
      level: transition === "backpressure" ? "warn" : "debug",
      marker,
      output: {
        ...this.stats(),
        operation: this.options.operation,
        transition,
      },
      requestId,
    });
  }

  private logProgress(
    job: QueueJob,
    progress: MediaWorkerProgress["progress"],
  ): void {
    const draft = {
      input: {
        active: this.active,
        operation: this.options.operation,
        queued: this.queued,
      },
      level: "debug" as const,
      output: progress,
      projectRevision: job.projectRevision,
      requestId: job.requestId,
    };
    const marker = this.logMarker();
    if (marker === "[IMPORT]") {
      this.options.logger?.log({
        ...draft,
        event: "progress",
        marker: "[IMPORT]",
      });
    } else if (marker === "[PROXY]") {
      this.options.logger?.log({
        ...draft,
        event: "generation.progress",
        marker: "[PROXY]",
      });
    } else {
      this.options.logger?.log({
        ...draft,
        event: "progress",
        marker: "[EXPORT]",
      });
    }
  }

  private logFinished(
    job: QueueJob,
    type: "cancelled" | "completed" | "failed",
    value: unknown,
  ): void {
    const common = {
      input: {
        active: this.active,
        operation: this.options.operation,
        queued: this.queued,
      },
      projectRevision: job.projectRevision,
      requestId: job.requestId,
    };
    const marker = this.logMarker();
    if (marker === "[IMPORT]") {
      this.options.logger?.log({
        ...common,
        error: type === "failed" ? value : undefined,
        event: type,
        level: type === "failed" ? "error" : "info",
        marker: "[IMPORT]",
        output: type === "completed" ? value : undefined,
      });
      return;
    }
    if (marker === "[PROXY]") {
      this.options.logger?.log({
        ...common,
        error: type === "failed" ? value : undefined,
        event: `generation.${type}` as
          "generation.cancelled" | "generation.completed" | "generation.failed",
        level: type === "failed" ? "error" : "info",
        marker,
        output: type === "completed" ? value : undefined,
      });
    } else {
      this.options.logger?.log({
        ...common,
        error: type === "failed" ? value : undefined,
        event: type,
        level: type === "failed" ? "error" : "info",
        marker,
        output: type === "completed" ? value : undefined,
      });
    }
  }

  private logMarker(): "[EXPORT]" | "[IMPORT]" | "[PROXY]" {
    return (
      this.options.marker ??
      (this.options.operation.includes("probe") ||
      this.options.operation === "import"
        ? "[IMPORT]"
        : this.options.operation.includes("export")
          ? "[EXPORT]"
          : "[PROXY]")
    );
  }
}

export type MediaTaskSchedulerOptions = {
  import?: Partial<
    Pick<BoundedTaskQueueOptions, "concurrency" | "highWatermark">
  >;
  proxy?: Partial<
    Pick<BoundedTaskQueueOptions, "concurrency" | "highWatermark">
  >;
  logger?: StructuredLogger;
};

export class MediaTaskScheduler {
  readonly imports: BoundedTaskQueue;
  readonly proxies: BoundedTaskQueue;

  constructor(client: WorkerClient, options: MediaTaskSchedulerOptions = {}) {
    this.imports = new BoundedTaskQueue(client, {
      concurrency: options.import?.concurrency ?? 2,
      highWatermark: options.import?.highWatermark ?? 8,
      logger: options.logger,
      operation: "import",
    });
    this.proxies = new BoundedTaskQueue(client, {
      concurrency: options.proxy?.concurrency ?? 1,
      highWatermark: options.proxy?.highWatermark ?? 4,
      logger: options.logger,
      operation: "proxy",
    });
  }

  dispose(): void {
    this.imports.dispose();
    this.proxies.dispose();
  }
}

export type QueueSizeSource = {
  queueSize: number;
};

export class QueueWatermarkGate {
  constructor(
    private readonly source: QueueSizeSource,
    readonly highWatermark: number,
    readonly lowWatermark = Math.max(0, highWatermark - 1),
    private readonly pollMs = 1,
  ) {
    validateLimit(highWatermark, "highWatermark");
    if (
      !Number.isSafeInteger(lowWatermark) ||
      lowWatermark < 0 ||
      lowWatermark >= highWatermark
    ) {
      throw new RangeError(
        "lowWatermark must be a non-negative integer below highWatermark",
      );
    }
  }

  async wait(signal?: AbortSignal): Promise<boolean> {
    if (this.source.queueSize < this.highWatermark) {
      return false;
    }
    while (this.source.queueSize > this.lowWatermark) {
      if (signal?.aborted) {
        throw cancelled(String(signal.reason ?? "Queue wait cancelled"));
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, this.pollMs);
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(cancelled(String(signal?.reason ?? "Queue wait cancelled")));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    return true;
  }
}

export type DecoderCodecName = "AudioDecoder" | "VideoDecoder";

export type CodecQueueObservation = {
  applicationQueue: QueueStats;
  codec: DecoderCodecName;
  implementation: "mediabunny";
  internalQueue: {
    available: false;
    highWatermark: null;
    peak: null;
    queueSize: null;
    reason: string;
  };
};

export type DecoderQueueTaskHandle<TResult> = {
  cancel(reason?: string): void;
  requestId: string;
  result: Promise<TResult>;
};

export type MediabunnyDecoderQueueAdapterOptions = {
  concurrency: number;
  highWatermark: number;
  logger?: StructuredLogger;
  overflowPolicy?: "reject" | "replace-oldest";
};

type DecoderQueueJob = {
  abort?: () => void;
  controller: AbortController;
  externalSignal?: AbortSignal;
  reject(reason: unknown): void;
  requestId: string;
  resolve(value: unknown): void;
  run(signal: AbortSignal): Promise<unknown>;
  settled: boolean;
  state: "active" | "queued";
};

const MEDIABUNNY_INTERNAL_QUEUE_REASON =
  "Mediabunny does not expose its internal WebCodecs decodeQueueSize; only the application scheduler is observable.";

export function createMediabunnyDecoderQueueObservation(
  codec: DecoderCodecName,
  applicationQueue: QueueStats = {
    active: 0,
    activePeak: 0,
    backpressureCount: 0,
    concurrency: 1,
    highWatermark: 1,
    queued: 0,
    queuedPeak: 0,
  },
): CodecQueueObservation {
  return {
    applicationQueue,
    codec,
    implementation: "mediabunny",
    internalQueue: {
      available: false,
      highWatermark: null,
      peak: null,
      queueSize: null,
      reason: MEDIABUNNY_INTERNAL_QUEUE_REASON,
    },
  };
}

export class MediabunnyDecoderQueueAdapter {
  private readonly activeJobs = new Set<DecoderQueueJob>();
  private readonly waiting: DecoderQueueJob[] = [];
  private activePeak = 0;
  private backpressureCount = 0;
  private disposed = false;
  private queuedPeak = 0;

  constructor(
    readonly codec: DecoderCodecName,
    readonly options: MediabunnyDecoderQueueAdapterOptions,
  ) {
    validateLimit(options.concurrency, "concurrency");
    validateLimit(options.highWatermark, "highWatermark");
  }

  schedule<TResult>(
    requestId: string,
    run: (signal: AbortSignal) => Promise<TResult>,
    signal?: AbortSignal,
  ): DecoderQueueTaskHandle<TResult> {
    if (this.disposed) {
      throw new Error(`${this.codec} application queue is disposed`);
    }
    if (this.waiting.length >= this.options.highWatermark) {
      this.backpressureCount += 1;
      this.logWatermark(requestId);
      if (this.options.overflowPolicy === "replace-oldest") {
        const replaced = this.waiting.shift();
        if (replaced) {
          this.rejectJob(
            replaced,
            cancelled(`${this.codec} request superseded at high watermark`),
          );
        }
      } else {
        throw new QueueBackpressureError(
          `${this.codec}.application`,
          this.options.highWatermark,
        );
      }
    }

    const controller = new AbortController();
    let resolvePromise!: (value: unknown) => void;
    let rejectPromise!: (reason: unknown) => void;
    const result = new Promise<TResult>((resolve, reject) => {
      resolvePromise = (value) => resolve(value as TResult);
      rejectPromise = reject;
    });
    const job: DecoderQueueJob = {
      controller,
      reject: rejectPromise,
      requestId,
      resolve: resolvePromise,
      run,
      settled: false,
      state: "queued",
    };
    if (signal) {
      job.externalSignal = signal;
      job.abort = () =>
        this.cancelJob(
          job,
          String(signal.reason ?? `${this.codec} request cancelled`),
        );
      if (signal.aborted) {
        job.abort();
      } else {
        signal.addEventListener("abort", job.abort, { once: true });
      }
    }
    if (!job.settled) {
      const previousPeak = this.queuedPeak;
      this.waiting.push(job);
      this.queuedPeak = Math.max(this.queuedPeak, this.waiting.length);
      if (
        this.queuedPeak > previousPeak ||
        this.waiting.length === this.options.highWatermark
      ) {
        this.logState("queued", requestId);
      }
      this.pump();
    }

    return {
      cancel: (reason = `${this.codec} request cancelled`) =>
        this.cancelJob(job, reason),
      requestId,
      result,
    };
  }

  stats(): CodecQueueObservation {
    return createMediabunnyDecoderQueueObservation(this.codec, {
      active: this.activeJobs.size,
      activePeak: this.activePeak,
      backpressureCount: this.backpressureCount,
      concurrency: this.options.concurrency,
      highWatermark: this.options.highWatermark,
      queued: this.waiting.length,
      queuedPeak: this.queuedPeak,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const job of [...this.waiting, ...this.activeJobs]) {
      this.cancelJob(job, `${this.codec} application queue disposed`);
    }
  }

  private pump(): void {
    while (
      !this.disposed &&
      this.activeJobs.size < this.options.concurrency &&
      this.waiting.length > 0
    ) {
      const job = this.waiting.shift()!;
      if (job.settled) {
        continue;
      }
      job.state = "active";
      this.activeJobs.add(job);
      const previousPeak = this.activePeak;
      this.activePeak = Math.max(this.activePeak, this.activeJobs.size);
      if (this.activePeak > previousPeak) {
        this.logState("started", job.requestId);
      }
      void job.run(job.controller.signal).then(
        (value) => this.finishJob(job, value),
        (error: unknown) => this.rejectJob(job, error),
      );
    }
  }

  private cancelJob(job: DecoderQueueJob, reason: string): void {
    if (job.settled) {
      return;
    }
    if (
      job.state === "queued" &&
      this.waiting.length >= this.options.highWatermark &&
      reason.toLowerCase().includes("superseded")
    ) {
      this.backpressureCount += 1;
      this.logWatermark(job.requestId);
    }
    job.controller.abort(reason);
    if (job.state === "active") {
      job.settled = true;
      job.reject(cancelled(reason));
      return;
    }
    const index = this.waiting.indexOf(job);
    if (index >= 0) {
      this.waiting.splice(index, 1);
    }
    this.rejectJob(job, cancelled(reason));
  }

  private finishJob(job: DecoderQueueJob, value: unknown): void {
    if (!job.settled) {
      job.settled = true;
      job.resolve(value);
    }
    this.cleanup(job);
  }

  private rejectJob(job: DecoderQueueJob, error: unknown): void {
    if (!job.settled) {
      job.settled = true;
      job.reject(error);
    }
    this.cleanup(job);
  }

  private cleanup(job: DecoderQueueJob): void {
    this.activeJobs.delete(job);
    const queuedIndex = this.waiting.indexOf(job);
    if (queuedIndex >= 0) {
      this.waiting.splice(queuedIndex, 1);
    }
    if (job.externalSignal && job.abort) {
      job.externalSignal.removeEventListener("abort", job.abort);
    }
    this.pump();
  }

  private logState(transition: string, requestId: string): void {
    this.options.logger?.log({
      event: "queue.state",
      level: "debug",
      marker: "[DECODE]",
      output: {
        ...this.stats(),
        transition,
      },
      requestId,
    });
  }

  private logWatermark(requestId: string): void {
    if (
      this.backpressureCount !== 1 &&
      (this.backpressureCount & (this.backpressureCount - 1)) !== 0
    ) {
      return;
    }
    this.options.logger?.log({
      event: "queue.watermark",
      level: "warn",
      marker: "[DECODE]",
      output: this.stats(),
      requestId,
    });
  }
}
