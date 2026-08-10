import { describe, expect, it } from "vitest";

import {
  canvasFilter,
  exportFrameCount,
  normalizedAudioTimestampUs,
} from "./export-pipeline";

describe("export pipeline timing and shared effect mapping", () => {
  it("iterates the complete output timeline at the configured FPS", () => {
    expect(exportFrameCount(2_000_000, 30)).toBe(60);
    expect(exportFrameCount(2_010_000, 30)).toBe(61);
  });

  it("normalizes a trimmed source timestamp onto project time", () => {
    expect(normalizedAudioTimestampUs(2_000_000, 1_000_000, 1_250_000)).toBe(
      2_250_000,
    );
  });

  it("maps normalized ECS effects to the export canvas", () => {
    expect(
      canvasFilter([
        { amount: 0.75, id: "vintage", kind: "vintage" },
        {
          brightness: 0.2,
          contrast: 0.5,
          id: "adjust",
          kind: "adjustments",
        },
      ]),
    ).toContain("sepia(0.75)");
    expect(
      canvasFilter([
        {
          brightness: 0.2,
          contrast: 0.5,
          id: "adjust",
          kind: "adjustments",
        },
      ]),
    ).toBe("brightness(1.2) contrast(0.75)");
  });
});
