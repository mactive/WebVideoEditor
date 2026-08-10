import {
  LogHub,
  StructuredLogger,
  validateLogEntry,
} from "@web-video-editor/observability";
import { describe, expect, it } from "vitest";

import {
  getActionAvailability,
  logCapabilityReport,
  type CapabilityId,
  type CapabilityReport,
  type CapabilityResult,
} from "./capabilities";

function capability(id: CapabilityId, supported = true): CapabilityResult {
  return {
    id,
    supported,
    detail: supported ? "可用" : "不可用",
    group: "platform",
    impact: "",
    label: id === "aacEncode" ? "AAC 编码" : id,
    suggestion: supported ? "无需处理。" : "升级浏览器。",
  };
}

describe("getActionAvailability", () => {
  it("disables only the actions affected by missing capabilities", () => {
    const report: CapabilityReport = {
      generatedAt: "2026-08-09T00:00:00.000Z",
      results: [
        capability("webCodecs"),
        capability("worker"),
        capability("opfs"),
        capability("h264Decode"),
        capability("aacDecode"),
        capability("h264Encode"),
        capability("aacEncode", false),
        capability("offscreenCanvas"),
        capability("webgl"),
        capability("webgpu", false),
        capability("sharedArrayBuffer", false),
        capability("crossOriginIsolated", false),
      ],
    };

    const actions = Object.fromEntries(
      getActionAvailability(report).map((action) => [action.id, action]),
    );

    expect(actions.import?.enabled).toBe(true);
    expect(actions.preview?.enabled).toBe(true);
    expect(actions.export?.enabled).toBe(false);
    expect(actions.export?.reason).toContain("AAC");
    expect(actions.export?.reason).toContain("建议");
    expect(actions.sharedMemory?.enabled).toBe(false);
    expect(actions.sharedMemory?.missing).toEqual([
      "sharedArrayBuffer",
      "crossOriginIsolated",
    ]);
  });

  it("writes capability diagnostics through the shared logger schema", () => {
    const hub = new LogHub();
    const report: CapabilityReport = {
      generatedAt: "2026-08-09T00:00:00.000Z",
      results: [
        capability("worker"),
        capability("opfs"),
        capability("webCodecs"),
        capability("h264Decode"),
        capability("aacDecode"),
        capability("h264Encode"),
        capability("aacEncode"),
        capability("offscreenCanvas"),
        capability("webgl"),
        capability("sharedArrayBuffer"),
        capability("crossOriginIsolated"),
      ],
    };

    logCapabilityReport(
      new StructuredLogger(hub, "editor-bootstrap"),
      report,
      getActionAvailability(report),
      12.345,
    );

    const entry = hub.getEntries()[0];
    expect(entry).toMatchObject({
      durationMs: 12.35,
      event: "capability.detected",
      marker: "[CAPABILITY]",
      scope: "editor-bootstrap",
    });
    expect(validateLogEntry(entry)).toEqual([]);
    expect(entry).not.toHaveProperty("error");
  });
});
