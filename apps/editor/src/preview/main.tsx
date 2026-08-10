import { listOpfsProxyManifests } from "@web-video-editor/media-runtime";
import {
  ConsoleLogSink,
  LogHub,
  StructuredLogger,
} from "@web-video-editor/observability";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";

import {
  detectCapabilities,
  getActionAvailability,
  logCapabilityReport,
  type ActionAvailability,
} from "../capabilities";
import "../styles.css";
import { createPreviewDemo } from "./demoProject";
import { PreviewPanel } from "./PreviewPanel";

type Demo = ReturnType<typeof createPreviewDemo>;

export function PreviewEntry() {
  const [demo, setDemo] = useState<Demo>();
  const [error, setError] = useState<string>();
  const [actionAvailability, setActionAvailability] =
    useState<ActionAvailability>();

  useEffect(() => {
    let active = true;
    const startedAt = performance.now();
    const logger = new StructuredLogger(
      new LogHub([new ConsoleLogSink()]),
      "preview-bootstrap",
    );
    void detectCapabilities()
      .then(async (report) => {
        if (!active) {
          return [];
        }
        const actions = getActionAvailability(report);
        logCapabilityReport(
          logger,
          report,
          actions,
          performance.now() - startedAt,
        );
        const preview = actions.find((action) => action.id === "preview");
        setActionAvailability(preview);
        if (!preview?.enabled) {
          throw new Error(`预览已禁用：${preview?.reason ?? "能力检测失败"}`);
        }
        return listOpfsProxyManifests();
      })
      .then((manifests) => {
        if (!active) {
          return;
        }
        const manifest = manifests
          .filter(
            (candidate) =>
              candidate.source.width === 720 && candidate.source.height === 720,
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .at(0);
        if (!manifest) {
          throw new Error(
            "未找到 test_1 的 OPFS 代理。请先返回素材页生成 test_1.mp4 代理。",
          );
        }
        setDemo(createPreviewDemo(manifest));
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <main>
        <section className="error-panel" role="alert">
          <strong>预览代理不可用</strong>
          <span>{error}</span>
          <a href="/">返回素材页</a>
        </section>
      </main>
    );
  }
  if (!demo) {
    return (
      <main>
        <p className="eyebrow">PREVIEW RUNTIME · LOADING OPFS</p>
      </main>
    );
  }
  return (
    <PreviewPanel
      actionAvailability={actionAvailability}
      project={demo.project}
      sources={demo.sources}
    />
  );
}

const root = document.getElementById("preview-root");
if (!root) {
  throw new Error("Preview root element is missing.");
}
createRoot(root).render(<PreviewEntry />);
