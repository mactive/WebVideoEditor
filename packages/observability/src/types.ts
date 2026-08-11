import type {
  LogEvent,
  LogLevel,
  LogMarker,
  MarkerEventPair,
} from "./dictionary";

export type LogPrimitive = boolean | null | number | string;

export type LogValue =
  LogPrimitive | { readonly [key: string]: LogValue } | readonly LogValue[];

export type SerializedLogError = {
  cause?: SerializedLogError | LogValue;
  context?: LogValue;
  message: string;
  name: string;
  stack?: string;
};

type LogEntryFields = {
  durationMs?: number;
  error?: SerializedLogError;
  input?: LogValue;
  level: LogLevel;
  output?: LogValue;
  projectRevision?: number;
  requestId?: string;
  scope: string;
  timestamp: string;
};

export type LogEntry = LogEntryFields & MarkerEventPair;

export type LogDraft<M extends LogMarker> = {
  durationMs?: number;
  error?: unknown;
  event: LogEvent<M>;
  input?: unknown;
  level: LogLevel;
  marker: M;
  output?: unknown;
  projectRevision?: number;
  requestId?: string;
  scope: string;
  timestamp?: string;
};

export interface LogSink {
  isEnabled?(): boolean;
  write(entry: LogEntry): void;
}

export type LogListener = (entry?: LogEntry) => void;
