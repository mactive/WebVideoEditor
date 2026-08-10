import { parseLogEntry } from "../schema";
import type { LogEntry, LogSink } from "../types";

export const WORKER_LOG_MESSAGE_TYPE = "observability.log";
export const WORKER_LOG_PROTOCOL_VERSION = 1;

export type WorkerLogMessage = {
  entry: LogEntry;
  type: typeof WORKER_LOG_MESSAGE_TYPE;
  version: typeof WORKER_LOG_PROTOCOL_VERSION;
};

export type WorkerMessageTarget = {
  postMessage(message: WorkerLogMessage): void;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function parseWorkerLogMessage(value: unknown): WorkerLogMessage {
  if (
    !isObject(value) ||
    Object.keys(value).some(
      (key) => key !== "entry" && key !== "type" && key !== "version",
    ) ||
    value.type !== WORKER_LOG_MESSAGE_TYPE ||
    value.version !== WORKER_LOG_PROTOCOL_VERSION
  ) {
    throw new TypeError("Invalid worker log message envelope");
  }

  return {
    entry: parseLogEntry(value.entry),
    type: WORKER_LOG_MESSAGE_TYPE,
    version: WORKER_LOG_PROTOCOL_VERSION,
  };
}

export function receiveWorkerLog(value: unknown, sink: LogSink): LogEntry {
  const message = parseWorkerLogMessage(value);
  sink.write(message.entry);
  return message.entry;
}

export class WorkerLogSink implements LogSink {
  constructor(private readonly target: WorkerMessageTarget) {}

  write(candidate: LogEntry): void {
    const entry = parseLogEntry(candidate);
    this.target.postMessage({
      entry,
      type: WORKER_LOG_MESSAGE_TYPE,
      version: WORKER_LOG_PROTOCOL_VERSION,
    });
  }
}
