import {
  MEDIA_WORKER_PROTOCOL_VERSION,
  MediaWorkerProtocolError,
  createWorkerError,
  parseMediaWorkerMessage,
  type MediaWorkerCancel,
  type MediaWorkerErrorMessage,
  type MediaWorkerInboundMessage,
  type MediaWorkerProgress,
  type MediaWorkerRequest,
  type MediaWorkerSuccess,
} from "./protocol";
import { TransferOwnershipLedger } from "./transfer";

export type WorkerMessageEndpoint = {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(
    message: Exclude<MediaWorkerInboundMessage, MediaWorkerRequest>,
    transfer?: Transferable[],
  ): void;
  postMessage(
    message: MediaWorkerErrorMessage | MediaWorkerProgress | MediaWorkerSuccess,
    transfer?: Transferable[],
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
};

export type WorkerTaskResult<TPayload = unknown> = {
  payload: TPayload;
  transfer?: readonly Transferable[];
};

export type WorkerTaskContext<TProgress = unknown> = {
  progress(
    progress: MediaWorkerProgress["progress"],
    payload?: TProgress,
  ): void;
  projectRevision: number;
  requestId: string;
  signal: AbortSignal;
};

export type WorkerTaskHandler<
  TPayload = unknown,
  TResult = unknown,
  TProgress = unknown,
> = (
  payload: TPayload,
  context: WorkerTaskContext<TProgress>,
) => Promise<WorkerTaskResult<TResult>> | WorkerTaskResult<TResult>;

export class WorkerTaskRegistry {
  private readonly handlers = new Map<string, WorkerTaskHandler>();

  register<TPayload, TResult, TProgress>(
    operation: string,
    handler: WorkerTaskHandler<TPayload, TResult, TProgress>,
  ): () => void {
    if (operation.length === 0) {
      throw new TypeError("Worker operation must be a non-empty string");
    }
    if (this.handlers.has(operation)) {
      throw new Error(`Worker operation "${operation}" is already registered`);
    }
    this.handlers.set(operation, handler as WorkerTaskHandler);
    return () => {
      if (this.handlers.get(operation) === handler) {
        this.handlers.delete(operation);
      }
    };
  }

  get(operation: string): WorkerTaskHandler | undefined {
    return this.handlers.get(operation);
  }

  has(operation: string): boolean {
    return this.handlers.has(operation);
  }

  get size(): number {
    return this.handlers.size;
  }
}

type ActiveWorkerTask = {
  controller: AbortController;
  projectRevision: number;
};

export type MediaWorkerHostStats = {
  activeTasks: number;
  malformedMessages: number;
  registeredOperations: number;
};

export class MediaWorkerHost {
  readonly ownership = new TransferOwnershipLedger();
  readonly registry: WorkerTaskRegistry;

  private readonly active = new Map<string, ActiveWorkerTask>();
  private disposed = false;
  private malformedMessages = 0;

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    let message: MediaWorkerInboundMessage;
    try {
      const parsed = parseMediaWorkerMessage(event.data);
      if (
        parsed.type !== "request" &&
        parsed.type !== "cancel" &&
        parsed.type !== "timeout"
      ) {
        throw new MediaWorkerProtocolError(
          `worker host received outbound message "${parsed.type}"`,
        );
      }
      message = parsed;
    } catch {
      this.malformedMessages += 1;
      return;
    }

    switch (message.type) {
      case "request":
        this.start(message);
        break;
      case "cancel":
        this.abort(message.requestId, message.projectRevision, message.reason);
        break;
      case "timeout":
        this.abort(
          message.requestId,
          message.projectRevision,
          `Task timed out after ${message.timeoutMs} ms`,
        );
        break;
    }
  };

  constructor(
    private readonly endpoint: WorkerMessageEndpoint,
    registry = new WorkerTaskRegistry(),
  ) {
    this.registry = registry;
    endpoint.addEventListener("message", this.onMessage);
  }

  register<TPayload, TResult, TProgress>(
    operation: string,
    handler: WorkerTaskHandler<TPayload, TResult, TProgress>,
  ): () => void {
    return this.registry.register(operation, handler);
  }

  stats(): MediaWorkerHostStats {
    return {
      activeTasks: this.active.size,
      malformedMessages: this.malformedMessages,
      registeredOperations: this.registry.size,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.endpoint.removeEventListener("message", this.onMessage);
    const errors: unknown[] = [];
    for (const [requestId, task] of this.active) {
      const message: MediaWorkerCancel = {
        projectRevision: task.projectRevision,
        reason: "MediaWorkerHost disposed",
        requestId,
        type: "cancel",
        version: MEDIA_WORKER_PROTOCOL_VERSION,
      };
      try {
        this.endpoint.postMessage(message);
      } catch (error) {
        errors.push(error);
      } finally {
        task.controller.abort(message.reason);
      }
    }
    this.active.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to cancel active worker tasks");
    }
  }

  private start(request: MediaWorkerRequest): void {
    if (this.disposed) {
      return;
    }
    const duplicate = this.active.get(request.requestId);
    if (duplicate) {
      this.active.delete(request.requestId);
      duplicate.controller.abort(
        `Duplicate worker requestId "${request.requestId}"`,
      );
      this.postError(
        request,
        new Error(`Worker task "${request.requestId}" is already active`),
        "DUPLICATE_REQUEST_ID",
      );
      return;
    }
    const handler = this.registry.get(request.operation);
    if (!handler) {
      this.postError(
        request,
        new Error(`Unknown worker operation "${request.operation}"`),
        "UNKNOWN_OPERATION",
      );
      return;
    }

    const controller = new AbortController();
    const active = {
      controller,
      projectRevision: request.projectRevision,
    };
    this.active.set(request.requestId, active);
    const context: WorkerTaskContext = {
      progress: (progress, payload) => {
        if (this.active.get(request.requestId) !== active) {
          return;
        }
        this.endpoint.postMessage({
          payload,
          progress,
          projectRevision: request.projectRevision,
          requestId: request.requestId,
          type: "progress",
          version: MEDIA_WORKER_PROTOCOL_VERSION,
        });
      },
      projectRevision: request.projectRevision,
      requestId: request.requestId,
      signal: controller.signal,
    };

    void Promise.resolve()
      .then(() => handler(request.payload, context))
      .then(
        (result) => {
          if (
            this.active.get(request.requestId) !== active ||
            controller.signal.aborted
          ) {
            return;
          }
          try {
            const message: MediaWorkerSuccess = {
              payload: result.payload,
              projectRevision: request.projectRevision,
              requestId: request.requestId,
              type: "success",
              version: MEDIA_WORKER_PROTOCOL_VERSION,
            };
            const transfer = [...(result.transfer ?? [])];
            const pending = this.ownership.begin(request.requestId, transfer);
            this.endpoint.postMessage(message, transfer);
            this.ownership.complete(request.requestId, pending);
            this.active.delete(request.requestId);
          } catch (error) {
            this.active.delete(request.requestId);
            this.postError(request, error, "WORKER_RESPONSE_FAILED");
          }
        },
        (error: unknown) => {
          if (this.active.get(request.requestId) !== active) {
            return;
          }
          this.active.delete(request.requestId);
          this.postError(request, error, "WORKER_TASK_FAILED");
        },
      );
  }

  private abort(
    requestId: string,
    projectRevision: number,
    reason: string,
  ): void {
    const active = this.active.get(requestId);
    if (!active || active.projectRevision !== projectRevision) {
      return;
    }
    this.active.delete(requestId);
    active.controller.abort(reason);
  }

  private postError(
    request: MediaWorkerRequest,
    error: unknown,
    code: string,
  ): void {
    this.endpoint.postMessage({
      error: createWorkerError(error, code),
      projectRevision: request.projectRevision,
      requestId: request.requestId,
      type: "error",
      version: MEDIA_WORKER_PROTOCOL_VERSION,
    });
  }
}
