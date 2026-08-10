import {
  parseLogEntry,
  type LogEntry,
  type LogLevel,
  type LogMarker,
} from "@web-video-editor/observability";

export type LogPanelFilters = {
  level: LogLevel | "all";
  marker: LogMarker | "all";
  scope: string;
  search: string;
};

export const DEFAULT_LOG_FILTERS: LogPanelFilters = {
  level: "all",
  marker: "all",
  scope: "",
  search: "",
};

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function filterLogEntries(
  entries: readonly LogEntry[],
  filters: LogPanelFilters,
): readonly LogEntry[] {
  const scope = normalized(filters.scope);
  const search = normalized(filters.search);

  return entries.filter((entry) => {
    if (filters.level !== "all" && entry.level !== filters.level) {
      return false;
    }
    if (filters.marker !== "all" && entry.marker !== filters.marker) {
      return false;
    }
    if (scope && !entry.scope.toLocaleLowerCase().includes(scope)) {
      return false;
    }
    return (
      !search || JSON.stringify(entry).toLocaleLowerCase().includes(search)
    );
  });
}

export function entriesToJsonl(entries: readonly LogEntry[]): string {
  if (entries.length === 0) {
    return "";
  }
  return `${entries.map((entry) => JSON.stringify(parseLogEntry(entry))).join("\n")}\n`;
}

export type ClipboardWriter = {
  writeText(text: string): Promise<void>;
};

export async function copyLogEntries(
  entries: readonly LogEntry[],
  clipboard: ClipboardWriter = navigator.clipboard,
): Promise<number> {
  await clipboard.writeText(entriesToJsonl(entries));
  return entries.length;
}

export type JsonlDownloadEnvironment = {
  createObjectUrl(blob: Blob): string;
  download(url: string, fileName: string): void;
  revokeObjectUrl(url: string): void;
};

function browserDownloadEnvironment(): JsonlDownloadEnvironment {
  return {
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    download: (url, fileName) => {
      const anchor = document.createElement("a");
      anchor.download = fileName;
      anchor.href = url;
      anchor.click();
    },
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  };
}

export function exportLogEntries(
  entries: readonly LogEntry[],
  fileName = `editor-logs-${new Date().toISOString().replaceAll(":", "-")}.jsonl`,
  environment: JsonlDownloadEnvironment = browserDownloadEnvironment(),
): string {
  const blob = new Blob([entriesToJsonl(entries)], {
    type: "application/x-ndjson;charset=utf-8",
  });
  const url = environment.createObjectUrl(blob);
  try {
    environment.download(url, fileName);
  } finally {
    environment.revokeObjectUrl(url);
  }
  return fileName;
}
