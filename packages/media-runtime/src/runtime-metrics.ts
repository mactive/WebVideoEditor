export type JsHeapMetrics = {
  available: boolean;
  jsHeapSizeLimit?: number;
  totalJSHeapSize?: number;
  usedJSHeapSize?: number;
};

export type StorageEstimateMetrics = {
  available: boolean;
  quotaBytes?: number;
  usageBytes?: number;
};

type PerformanceWithMemory = Performance & {
  memory?: {
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
    usedJSHeapSize?: number;
  };
};

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sampleJsHeapMetrics(
  source: Performance = performance,
): JsHeapMetrics {
  const memory = (source as PerformanceWithMemory).memory;
  if (!memory || !finiteNonNegative(memory.usedJSHeapSize)) {
    return { available: false };
  }
  return {
    available: true,
    ...(finiteNonNegative(memory.jsHeapSizeLimit)
      ? { jsHeapSizeLimit: memory.jsHeapSizeLimit }
      : {}),
    ...(finiteNonNegative(memory.totalJSHeapSize)
      ? { totalJSHeapSize: memory.totalJSHeapSize }
      : {}),
    usedJSHeapSize: memory.usedJSHeapSize,
  };
}

export async function sampleStorageEstimate(
  storage: Pick<StorageManager, "estimate"> | undefined = navigator.storage,
): Promise<StorageEstimateMetrics> {
  if (typeof storage?.estimate !== "function") {
    return { available: false };
  }
  try {
    const estimate = await storage.estimate();
    const usageBytes = estimate.usage;
    const quotaBytes = estimate.quota;
    if (!finiteNonNegative(usageBytes) && !finiteNonNegative(quotaBytes)) {
      return { available: false };
    }
    return {
      available: true,
      ...(finiteNonNegative(quotaBytes) ? { quotaBytes } : {}),
      ...(finiteNonNegative(usageBytes) ? { usageBytes } : {}),
    };
  } catch {
    return { available: false };
  }
}
