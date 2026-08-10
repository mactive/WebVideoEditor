import {
  LOG_LEVELS,
  MARKER_EVENTS,
  type LogEntry,
  type LogLevel,
  type LogMarker,
} from "@web-video-editor/observability";
import { useMemo, useState, useSyncExternalStore } from "react";

import "./LogPanel.css";
import {
  DEFAULT_LOG_FILTERS,
  copyLogEntries,
  entriesToJsonl,
  exportLogEntries,
  filterLogEntries,
  type LogPanelFilters,
} from "./logPanelModel";

export type LogPanelSource = {
  clear(): void;
  getEntries(): readonly LogEntry[];
  subscribe(listener: (entry?: LogEntry) => void): () => void;
};

export type LogPanelProps = {
  className?: string;
  source: LogPanelSource;
  title?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LogPanel({
  className = "",
  source,
  title = "结构化日志",
}: LogPanelProps) {
  const [filters, setFilters] = useState<LogPanelFilters>(DEFAULT_LOG_FILTERS);
  const [status, setStatus] = useState("");
  const entries = useSyncExternalStore(
    (onStoreChange) => source.subscribe(onStoreChange),
    () => source.getEntries(),
    () => source.getEntries(),
  );

  const filteredEntries = useMemo(
    () => filterLogEntries(entries, filters),
    [entries, filters],
  );

  const updateFilter = <K extends keyof LogPanelFilters>(
    key: K,
    value: LogPanelFilters[K],
  ) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const copy = async () => {
    try {
      const count = await copyLogEntries(filteredEntries);
      setStatus(`已复制 ${count} 条 JSONL 日志`);
    } catch (error) {
      setStatus(`复制失败：${errorMessage(error)}`);
    }
  };

  const clear = () => {
    source.clear();
    setStatus("日志已清空");
  };

  const exportJsonl = () => {
    try {
      const fileName = exportLogEntries(filteredEntries);
      setStatus(`已导出 ${fileName}`);
    } catch (error) {
      setStatus(`导出失败：${errorMessage(error)}`);
    }
  };

  const markerOptions = Object.keys(MARKER_EVENTS) as LogMarker[];

  return (
    <section
      aria-label={title}
      className={`log-panel ${className}`.trim()}
      data-testid="log-panel"
    >
      <header className="log-panel__header">
        <div>
          <h2>{title}</h2>
          <p>
            显示 {filteredEntries.length} / {entries.length} 条
          </p>
        </div>
        <div className="log-panel__actions">
          <button
            disabled={filteredEntries.length === 0}
            onClick={() => void copy()}
            type="button"
          >
            复制 JSONL
          </button>
          <button onClick={clear} type="button">
            清空
          </button>
          <button
            disabled={filteredEntries.length === 0}
            onClick={exportJsonl}
            type="button"
          >
            导出 JSONL
          </button>
        </div>
      </header>

      <div className="log-panel__filters">
        <label>
          级别
          <select
            onChange={(event) =>
              updateFilter("level", event.target.value as LogLevel | "all")
            }
            value={filters.level}
          >
            <option value="all">全部</option>
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
        <label>
          Marker
          <select
            onChange={(event) =>
              updateFilter("marker", event.target.value as LogMarker | "all")
            }
            value={filters.marker}
          >
            <option value="all">全部</option>
            {markerOptions.map((marker) => (
              <option key={marker} value={marker}>
                {marker}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope
          <input
            onChange={(event) => updateFilter("scope", event.target.value)}
            placeholder="例如 media-worker"
            type="search"
            value={filters.scope}
          />
        </label>
        <label>
          搜索
          <input
            onChange={(event) => updateFilter("search", event.target.value)}
            placeholder="requestId、event 或上下文"
            type="search"
            value={filters.search}
          />
        </label>
      </div>

      <p aria-live="polite" className="log-panel__status">
        {status}
      </p>

      <ol className="log-panel__entries">
        {filteredEntries.map((entry, index) => (
          <li
            className={`log-panel__entry log-panel__entry--${entry.level}`}
            key={`${entry.timestamp}:${entry.requestId ?? "none"}:${entry.event}:${index}`}
          >
            <div className="log-panel__entry-summary">
              <time dateTime={entry.timestamp}>
                {new Date(entry.timestamp).toLocaleTimeString()}
              </time>
              <strong>{entry.marker}</strong>
              <span>{entry.scope}</span>
              <code>{entry.event}</code>
              {entry.requestId && <code>{entry.requestId}</code>}
            </div>
            <details>
              <summary>JSON</summary>
              <pre>{JSON.stringify(entry, null, 2)}</pre>
            </details>
          </li>
        ))}
      </ol>

      <textarea
        aria-label="当前筛选结果 JSONL"
        className="log-panel__jsonl"
        readOnly
        value={entriesToJsonl(filteredEntries)}
      />
    </section>
  );
}
