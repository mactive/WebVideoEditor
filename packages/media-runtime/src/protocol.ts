import {
  serializeError,
  type SerializedLogError,
} from "@web-video-editor/observability";

export const MEDIA_WORKER_PROTOCOL_VERSION = 1 as const;

export type MediaWorkerError = SerializedLogError & {
  code: string;
  recoverable: boolean;
};

type MessageBase = {
  version: typeof MEDIA_WORKER_PROTOCOL_VERSION;
  requestId: string;
  projectRevision: number;
};

export type MediaWorkerRequest<TPayload = unknown> = MessageBase & {
  type: "request";
  operation: string;
  payload: TPayload;
};

export type MediaWorkerProgress<TPayload = unknown> = MessageBase & {
  type: "progress";
  progress: {
    completed: number;
    ratio: number;
    stage: string;
    total?: number;
  };
  payload?: TPayload;
};

export type MediaWorkerSuccess<TPayload = unknown> = MessageBase & {
  type: "success";
  payload: TPayload;
};

export type MediaWorkerCancel = MessageBase & {
  type: "cancel";
  reason: string;
};

export type MediaWorkerTimeout = MessageBase & {
  type: "timeout";
  timeoutMs: number;
};

export type MediaWorkerErrorMessage = MessageBase & {
  type: "error";
  error: MediaWorkerError;
};

export type MediaWorkerMessage =
  | MediaWorkerCancel
  | MediaWorkerErrorMessage
  | MediaWorkerProgress
  | MediaWorkerRequest
  | MediaWorkerSuccess
  | MediaWorkerTimeout;

export type MediaWorkerInboundMessage =
  MediaWorkerCancel | MediaWorkerRequest | MediaWorkerTimeout;

export type MediaWorkerOutboundMessage =
  | MediaWorkerCancel
  | MediaWorkerErrorMessage
  | MediaWorkerProgress
  | MediaWorkerSuccess
  | MediaWorkerTimeout;

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class MediaWorkerProtocolError extends TypeError {
  constructor(message: string) {
    super(`Invalid media worker message: ${message}`);
    this.name = "MediaWorkerProtocolError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertBase(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & MessageBase {
  if (value.version !== MEDIA_WORKER_PROTOCOL_VERSION) {
    throw new MediaWorkerProtocolError("unsupported version");
  }
  if (
    typeof value.requestId !== "string" ||
    !requestIdPattern.test(value.requestId)
  ) {
    throw new MediaWorkerProtocolError("invalid requestId");
  }
  if (
    typeof value.projectRevision !== "number" ||
    !Number.isSafeInteger(value.projectRevision) ||
    value.projectRevision < 0
  ) {
    throw new MediaWorkerProtocolError("invalid projectRevision");
  }
}

function parseProgress(value: unknown): MediaWorkerProgress["progress"] {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["completed", "ratio", "stage", "total"]) ||
    typeof value.completed !== "number" ||
    !Number.isFinite(value.completed) ||
    value.completed < 0 ||
    typeof value.ratio !== "number" ||
    !Number.isFinite(value.ratio) ||
    value.ratio < 0 ||
    value.ratio > 1 ||
    typeof value.stage !== "string" ||
    value.stage.length === 0 ||
    (value.total !== undefined &&
      (typeof value.total !== "number" ||
        !Number.isFinite(value.total) ||
        value.total < value.completed))
  ) {
    throw new MediaWorkerProtocolError("invalid progress");
  }
  return value as MediaWorkerProgress["progress"];
}

function parseError(value: unknown): MediaWorkerError {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "cause",
      "code",
      "context",
      "message",
      "name",
      "recoverable",
      "stack",
    ]) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    typeof value.message !== "string" ||
    typeof value.recoverable !== "boolean"
  ) {
    throw new MediaWorkerProtocolError("invalid error");
  }
  return value as MediaWorkerError;
}

export function parseMediaWorkerMessage(value: unknown): MediaWorkerMessage {
  if (!isObject(value) || typeof value.type !== "string") {
    throw new MediaWorkerProtocolError("message must be an object");
  }
  assertBase(value);

  switch (value.type) {
    case "request":
      if (
        !hasOnlyKeys(value, [
          "operation",
          "payload",
          "projectRevision",
          "requestId",
          "type",
          "version",
        ]) ||
        typeof value.operation !== "string" ||
        value.operation.length === 0 ||
        !("payload" in value)
      ) {
        throw new MediaWorkerProtocolError("invalid request");
      }
      return value as MediaWorkerRequest;
    case "progress":
      if (
        !hasOnlyKeys(value, [
          "payload",
          "progress",
          "projectRevision",
          "requestId",
          "type",
          "version",
        ])
      ) {
        throw new MediaWorkerProtocolError("invalid progress envelope");
      }
      return {
        ...value,
        progress: parseProgress(value.progress),
      } as MediaWorkerProgress;
    case "success":
      if (
        !hasOnlyKeys(value, [
          "payload",
          "projectRevision",
          "requestId",
          "type",
          "version",
        ]) ||
        !("payload" in value)
      ) {
        throw new MediaWorkerProtocolError("invalid success");
      }
      return value as MediaWorkerSuccess;
    case "cancel":
      if (
        !hasOnlyKeys(value, [
          "projectRevision",
          "reason",
          "requestId",
          "type",
          "version",
        ]) ||
        typeof value.reason !== "string" ||
        value.reason.length === 0
      ) {
        throw new MediaWorkerProtocolError("invalid cancel");
      }
      return value as MediaWorkerCancel;
    case "timeout":
      if (
        !hasOnlyKeys(value, [
          "projectRevision",
          "requestId",
          "timeoutMs",
          "type",
          "version",
        ]) ||
        typeof value.timeoutMs !== "number" ||
        !Number.isFinite(value.timeoutMs) ||
        value.timeoutMs <= 0
      ) {
        throw new MediaWorkerProtocolError("invalid timeout");
      }
      return value as MediaWorkerTimeout;
    case "error":
      if (
        !hasOnlyKeys(value, [
          "error",
          "projectRevision",
          "requestId",
          "type",
          "version",
        ])
      ) {
        throw new MediaWorkerProtocolError("invalid error envelope");
      }
      return {
        ...value,
        error: parseError(value.error),
      } as MediaWorkerErrorMessage;
    default:
      throw new MediaWorkerProtocolError(`unknown type "${value.type}"`);
  }
}

export function createWorkerError(
  error: unknown,
  code = "WORKER_TASK_FAILED",
  recoverable = false,
): MediaWorkerError {
  return {
    ...serializeError(error),
    code,
    recoverable,
  };
}
