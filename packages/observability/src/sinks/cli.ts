import { parseLogEntry } from "../schema";
import type { LogEntry, LogSink } from "../types";

export type TextWriter = (text: string) => void;

export type CliLogSinkOptions = {
  humanWriter?: TextWriter;
  jsonlWriter?: TextWriter;
};

function contextJson(entry: LogEntry): string {
  return JSON.stringify({
    durationMs: entry.durationMs,
    error: entry.error,
    input: entry.input,
    output: entry.output,
    projectRevision: entry.projectRevision,
    requestId: entry.requestId,
  });
}

export function formatCliLogLine(entry: LogEntry): string {
  const request = entry.requestId ? ` requestId=${entry.requestId}` : "";
  const revision =
    entry.projectRevision === undefined
      ? ""
      : ` projectRevision=${entry.projectRevision}`;
  return `${entry.marker} ${entry.level.toUpperCase()} ${entry.scope} ${entry.event}${request}${revision} ${contextJson(entry)}`;
}

export class CliLogSink implements LogSink {
  constructor(private readonly options: CliLogSinkOptions) {
    if (!options.humanWriter && !options.jsonlWriter) {
      throw new TypeError("CliLogSink requires a human or JSONL writer");
    }
  }

  write(candidate: LogEntry): void {
    const entry = parseLogEntry(candidate);
    this.options.humanWriter?.(`${formatCliLogLine(entry)}\n`);
    this.options.jsonlWriter?.(`${JSON.stringify(entry)}\n`);
  }
}
