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
import { SyncDebugPanel } from "./SyncDebugPanel";

const root = document.getElementById("sync-debug-root");
if (!root) {
  throw new Error("Sync debug root element is missing.");
}

export function SyncDebugEntry() {
  const [actionAvailability, setActionAvailability] =
    useState<ActionAvailability>();

  useEffect(() => {
    let active = true;
    const startedAt = performance.now();
    const logger = new StructuredLogger(
      new LogHub([new ConsoleLogSink()]),
      "sync-debug-bootstrap",
    );
    void detectCapabilities().then((report) => {
      if (!active) {
        return;
      }
      const actions = getActionAvailability(report);
      logCapabilityReport(
        logger,
        report,
        actions,
        performance.now() - startedAt,
      );
      setActionAvailability(
        actions.find((action) => action.id === "sharedMemory"),
      );
    });
    return () => {
      active = false;
    };
  }, []);

  return <SyncDebugPanel actionAvailability={actionAvailability} />;
}

createRoot(root).render(<SyncDebugEntry />);
