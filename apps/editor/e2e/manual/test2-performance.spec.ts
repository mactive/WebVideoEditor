import { expect, test } from "@playwright/test";

test("@manual test_2 streams, cancels cleanly, and reuses OPFS cache", async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  await page.goto("/");

  const evidence = await page.evaluate(async () => {
    type ProtocolMessage = {
      error?: { message?: string };
      payload?: unknown;
      progress?: { stage: string };
      projectRevision?: number;
      requestId?: string;
      type?: string;
    };
    type ProbeProgress = {
      bytesRead: number;
      fileSize: number;
      heap: { available: boolean; usedJSHeapSize?: number };
      stage: string;
    };
    type ProbeResult = {
      durationSec: number;
      fingerprint: string;
      primaryAudioTrackId: number | null;
      primaryVideoTrackId: number;
      read: {
        fullFileRead: boolean;
        readRatio: number;
        uniqueBytesRead: number;
      };
      source: { size: number };
      videoTracks: Array<{
        codec: string | null;
        displayHeight: number;
        displayWidth: number;
        trackId: number;
      }>;
    };
    type ProxyResult = {
      cache: {
        committedBytes: number;
        status: "hit" | "miss";
        storageEstimate: {
          available: boolean;
          quotaBytes?: number;
          usageBytes?: number;
        };
        temporaryEntries: number;
      };
      elapsedMs: number;
      manifest: { proxy: { byteLength: number; durationSec: number } };
    };

    const worker = new Worker("/src/media/media.worker.ts", {
      name: "task12-test2-manual",
      type: "module",
    });
    let sequence = 0;
    const request = <T>(
      operation: string,
      payload: unknown,
      onProgress?: (payload: unknown, stage: string) => void,
    ): Promise<T> => {
      const requestId = `manual_${++sequence}`;
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.removeEventListener("message", listener);
          reject(new Error(`${operation} timed out (${requestId})`));
        }, 8 * 60_000);
        const listener = (event: MessageEvent<ProtocolMessage>) => {
          const message = event.data;
          if (message.requestId !== requestId) {
            return;
          }
          if (message.type === "progress") {
            onProgress?.(message.payload, message.progress?.stage ?? "unknown");
            return;
          }
          if (message.type !== "success" && message.type !== "error") {
            return;
          }
          clearTimeout(timeout);
          worker.removeEventListener("message", listener);
          if (message.type === "error") {
            reject(
              new Error(
                `${operation} failed (${requestId}): ${message.error?.message ?? "unknown worker error"}`,
              ),
            );
          } else {
            resolve(message.payload as T);
          }
        };
        worker.addEventListener("message", listener);
        worker.postMessage({
          operation,
          payload,
          projectRevision: 0,
          requestId,
          type: "request",
          version: 1,
        });
      });
    };

    const clear = await request<ProxyResult["cache"]>(
      "media.proxy.cache.clear",
      {},
    );
    const probeProgress: ProbeProgress[] = [];
    const probeStarted = performance.now();
    const probe = await request<ProbeResult>(
      "media.probe",
      {
        source: {
          kind: "test-asset",
          name: "test_2.mp4",
          url: "/test_assets/test_2.mp4",
        },
      },
      (payload) => probeProgress.push(payload as ProbeProgress),
    );
    const probeElapsedMs = performance.now() - probeStarted;
    const parameters = {
      frameRate: 15,
      keyFrameIntervalSec: 1,
      maxDurationSec: 2,
      maxHeight: 180,
      maxWidth: 320,
      thumbnailIntervalSec: 1,
      thumbnailWidth: 96,
      waveformBuckets: 32,
    };

    const cancelRequestId = `manual_${++sequence}`;
    let cancellationStage = "not-started";
    const cancelled = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("test_2 cancellation did not reach progress")),
        2 * 60_000,
      );
      const listener = (event: MessageEvent<ProtocolMessage>) => {
        const message = event.data;
        if (message.requestId !== cancelRequestId) {
          return;
        }
        if (message.type === "error") {
          clearTimeout(timeout);
          worker.removeEventListener("message", listener);
          reject(
            new Error(
              `cancel target failed before cancellation: ${message.error?.message}`,
            ),
          );
          return;
        }
        if (
          message.type === "progress" &&
          message.progress?.stage !== "cache"
        ) {
          cancellationStage = message.progress?.stage ?? "unknown";
          worker.postMessage({
            projectRevision: 0,
            reason: "Task 12 manual cancellation",
            requestId: cancelRequestId,
            type: "cancel",
            version: 1,
          });
          clearTimeout(timeout);
          worker.removeEventListener("message", listener);
          resolve(true);
        }
      };
      worker.addEventListener("message", listener);
      worker.postMessage({
        operation: "media.proxy.generate",
        payload: { fingerprint: probe.fingerprint, parameters },
        projectRevision: 0,
        requestId: cancelRequestId,
        type: "request",
        version: 1,
      });
    });

    const cancellationDeadline = performance.now() + 30_000;
    let afterCancel: ProxyResult["cache"];
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      afterCancel = await request<ProxyResult["cache"]>(
        "media.proxy.cache.stats",
        {},
      );
      if (afterCancel.temporaryEntries === 0) {
        break;
      }
    } while (performance.now() < cancellationDeadline);

    const first = await request<ProxyResult>("media.proxy.generate", {
      fingerprint: probe.fingerprint,
      parameters,
    });
    const second = await request<ProxyResult>("media.proxy.generate", {
      fingerprint: probe.fingerprint,
      parameters,
    });
    const pageMemory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number };
      }
    ).memory;
    worker.terminate();

    return {
      afterCancel,
      cacheInitiallyEmpty: clear.committedBytes === 0,
      cancellationStage,
      cancelled,
      first,
      pageHeapBytes: pageMemory?.usedJSHeapSize,
      probe,
      probeElapsedMs,
      probeProgress,
      second,
    };
  });

  const video = evidence.probe.videoTracks.find(
    (track) => track.trackId === evidence.probe.primaryVideoTrackId,
  );
  expect(video).toMatchObject({
    codec: "avc",
    displayHeight: 1080,
    displayWidth: 1920,
  });
  expect(evidence.probe.primaryAudioTrackId).not.toBeNull();
  expect(evidence.probe.durationSec).toBeGreaterThan(3_200);
  expect(evidence.probe.read.fullFileRead).toBe(false);
  expect(evidence.probe.read.readRatio).toBeLessThan(0.02);
  expect(evidence.probe.read.uniqueBytesRead).toBeLessThan(
    evidence.probe.source.size * 0.02,
  );
  expect(evidence.probeProgress.length).toBeGreaterThan(0);
  expect(
    evidence.probeProgress.every(
      (progress) => typeof progress.heap.available === "boolean",
    ),
  ).toBe(true);
  expect(evidence.pageHeapBytes).toBeGreaterThan(0);

  expect(evidence.cacheInitiallyEmpty).toBe(true);
  expect(evidence.cancelled).toBe(true);
  expect(evidence.cancellationStage).not.toBe("not-started");
  expect(evidence.afterCancel.temporaryEntries).toBe(0);
  expect(evidence.first.cache.status).toBe("miss");
  expect(evidence.first.manifest.proxy.durationSec).toBeLessThanOrEqual(2.1);
  expect(evidence.first.manifest.proxy.byteLength).toBeGreaterThan(10_000);
  expect(evidence.second.cache.status).toBe("hit");
  expect(evidence.second.elapsedMs).toBeLessThan(evidence.first.elapsedMs);
  expect(evidence.second.cache.temporaryEntries).toBe(0);
  expect(evidence.second.cache.storageEstimate.available).toBe(true);
  expect(
    evidence.second.cache.storageEstimate.usageBytes,
  ).toBeGreaterThanOrEqual(evidence.second.cache.committedBytes);

  console.info(
    `[TASK12_TEST2] ${JSON.stringify({
      cacheBytes: evidence.second.cache.committedBytes,
      cancellationStage: evidence.cancellationStage,
      firstProxyMs: Math.round(evidence.first.elapsedMs),
      heapBytes: evidence.pageHeapBytes,
      probeBytes: evidence.probe.read.uniqueBytesRead,
      probeMs: Math.round(evidence.probeElapsedMs),
      readRatio: evidence.probe.read.readRatio,
      secondProxyMs: Math.round(evidence.second.elapsedMs),
    })}`,
  );
});
