import { parseLogEntry } from "../schema";
import type { LogEntry, LogSink } from "../types";

export type ConsoleTarget = Pick<Console, "debug" | "error" | "info" | "warn">;

export class ConsoleLogSink implements LogSink {
  constructor(private readonly target: ConsoleTarget = console) {}

  write(candidate: LogEntry): void {
    const entry = parseLogEntry(candidate);
    this.target[entry.level](JSON.stringify(entry));
  }
}
