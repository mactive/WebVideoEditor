import type { LogEvent, LogMarker } from "./dictionary";
import { parseLogEntry } from "./schema";
import { serializeError, summarize } from "./serialize";
import type { LogDraft, LogEntry, LogListener, LogSink } from "./types";

let requestCounter = 0;

export type Clock = () => Date;

export function createRequestId(prefix = "req"): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === "function") {
    return `${prefix}_${cryptoObject.randomUUID()}`;
  }
  requestCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${requestCounter.toString(36)}`;
}

export function createLogEntry<M extends LogMarker>(
  draft: LogDraft<M>,
  clock: Clock = () => new Date(),
): LogEntry {
  const entry = {
    durationMs: draft.durationMs,
    error:
      draft.error === undefined
        ? undefined
        : serializeError(draft.error, {
            event: draft.event,
            input: draft.input,
            marker: draft.marker,
            scope: draft.scope,
          }),
    event: draft.event,
    input: draft.input === undefined ? undefined : summarize(draft.input),
    level: draft.level,
    marker: draft.marker,
    output: draft.output === undefined ? undefined : summarize(draft.output),
    projectRevision: draft.projectRevision,
    requestId: draft.requestId,
    scope: draft.scope,
    timestamp: draft.timestamp ?? clock().toISOString(),
  };

  return parseLogEntry(
    Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined),
    ),
  );
}

export class StructuredLogger {
  constructor(
    private readonly sink: LogSink,
    private readonly defaultScope: string,
    private readonly clock: Clock = () => new Date(),
  ) {}

  log<M extends LogMarker>(
    draft: Omit<LogDraft<M>, "scope"> & { scope?: string },
  ): LogEntry {
    const entry = createLogEntry(
      {
        ...draft,
        scope: draft.scope ?? this.defaultScope,
      },
      this.clock,
    );
    this.sink.write(entry);
    return entry;
  }

  trace(
    options: {
      projectRevision?: number;
      requestId?: string;
      requestIdPrefix?: string;
    } = {},
  ): RequestTrace {
    return new RequestTrace(
      this,
      options.requestId ?? createRequestId(options.requestIdPrefix),
      options.projectRevision,
    );
  }
}

export class RequestTrace {
  constructor(
    private readonly logger: StructuredLogger,
    readonly requestId: string,
    readonly projectRevision?: number,
  ) {}

  log<M extends LogMarker>(
    draft: Omit<LogDraft<M>, "projectRevision" | "requestId" | "scope"> & {
      projectRevision?: number;
      scope?: string;
    },
  ): LogEntry {
    return this.logger.log({
      ...draft,
      projectRevision: draft.projectRevision ?? this.projectRevision,
      requestId: this.requestId,
    });
  }
}

export type LogQuery = {
  event?: string;
  level?: LogEntry["level"];
  marker?: LogMarker;
  requestId?: string;
  scope?: string;
};

export class LogHub implements LogSink {
  private entries: readonly LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();
  private readonly sinks = new Set<LogSink>();

  constructor(
    sinks: readonly LogSink[] = [],
    private readonly capacity = 2_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("LogHub capacity must be a positive safe integer");
    }
    for (const sink of sinks) {
      this.sinks.add(sink);
    }
  }

  addSink(sink: LogSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  clear(): void {
    this.entries = [];
    this.notify();
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  query(query: LogQuery = {}): readonly LogEntry[] {
    return this.entries.filter(
      (entry) =>
        (query.event === undefined || entry.event === query.event) &&
        (query.level === undefined || entry.level === query.level) &&
        (query.marker === undefined || entry.marker === query.marker) &&
        (query.requestId === undefined ||
          entry.requestId === query.requestId) &&
        (query.scope === undefined || entry.scope === query.scope),
    );
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(candidate: LogEntry): void {
    const entry = parseLogEntry(candidate);
    this.entries = [...this.entries, entry].slice(-this.capacity);
    for (const sink of this.sinks) {
      sink.write(entry);
    }
    this.notify(entry);
  }

  private notify(entry?: LogEntry): void {
    for (const listener of this.listeners) {
      listener(entry);
    }
  }
}

export type TraceStep<M extends LogMarker> = {
  event: LogEvent<M>;
  marker: M;
};
