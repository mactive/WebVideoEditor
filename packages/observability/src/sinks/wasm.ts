import type { LogEvent, LogLevel } from "../dictionary";
import { StructuredLogger, type Clock } from "../logger";
import type { LogEntry, LogSink } from "../types";

export type WasmDiagnostic = {
  durationMs?: number;
  error?: unknown;
  event: LogEvent<"[WASM]">;
  input?: unknown;
  level?: LogLevel;
  output?: unknown;
  projectRevision?: number;
  requestId?: string;
};

export class WasmLogSink {
  private readonly logger: StructuredLogger;

  constructor(sink: LogSink, scope = "wasm-wrapper", clock?: Clock) {
    this.logger = new StructuredLogger(sink, scope, clock);
  }

  write(diagnostic: WasmDiagnostic): LogEntry {
    return this.logger.log({
      ...diagnostic,
      level:
        diagnostic.level ??
        (diagnostic.event === "call.failed" ? "error" : "info"),
      marker: "[WASM]",
    });
  }
}
