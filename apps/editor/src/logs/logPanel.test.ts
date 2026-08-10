import { LogHub, MARKER_LOG_EXAMPLES } from "@web-video-editor/observability";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LogPanel } from "./LogPanel";
import {
  DEFAULT_LOG_FILTERS,
  copyLogEntries,
  entriesToJsonl,
  exportLogEntries,
  filterLogEntries,
} from "./logPanelModel";

describe("LogPanel model", () => {
  it("filters by level, marker, scope and full-entry search", () => {
    const filtered = filterLogEntries(MARKER_LOG_EXAMPLES, {
      level: "debug",
      marker: "[DECODE]",
      scope: "worker",
      search: "18400000",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.event).toBe("frame");
    expect(filterLogEntries(MARKER_LOG_EXAMPLES, DEFAULT_LOG_FILTERS)).toEqual(
      MARKER_LOG_EXAMPLES,
    );
  });

  it("creates valid newline-delimited JSON", () => {
    const entries = MARKER_LOG_EXAMPLES.slice(0, 3);
    const jsonl = entriesToJsonl(entries);
    const parsed = jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(entries);
    expect(entriesToJsonl([])).toBe("");
  });

  it("copies the currently supplied entries", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const entries = MARKER_LOG_EXAMPLES.slice(0, 2);

    await expect(copyLogEntries(entries, { writeText })).resolves.toBe(2);
    expect(writeText).toHaveBeenCalledWith(entriesToJsonl(entries));
  });

  it("exports a JSONL blob and always revokes its URL", async () => {
    let blob: Blob | undefined;
    const download = vi.fn();
    const revokeObjectUrl = vi.fn();
    const fileName = exportLogEntries(
      MARKER_LOG_EXAMPLES.slice(0, 1),
      "trace.jsonl",
      {
        createObjectUrl: (value) => {
          blob = value;
          return "blob:trace";
        },
        download,
        revokeObjectUrl,
      },
    );

    expect(fileName).toBe("trace.jsonl");
    expect(download).toHaveBeenCalledWith("blob:trace", "trace.jsonl");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:trace");
    expect(blob?.type).toBe("application/x-ndjson;charset=utf-8");
    await expect(blob?.text()).resolves.toBe(
      entriesToJsonl(MARKER_LOG_EXAMPLES.slice(0, 1)),
    );
  });
});

describe("LogPanel", () => {
  it("renders as an independent panel with all required actions", () => {
    const hub = new LogHub();
    const entry = MARKER_LOG_EXAMPLES[4];
    if (!entry) {
      throw new Error("missing seek example");
    }
    hub.write(entry);

    const html = renderToStaticMarkup(createElement(LogPanel, { source: hub }));

    expect(html).toContain("结构化日志");
    expect(html).toContain("复制 JSONL");
    expect(html).toContain("清空");
    expect(html).toContain("导出 JSONL");
    expect(html).toContain("requestId、event 或上下文");
    expect(html).toContain("seek_42");
  });
});
