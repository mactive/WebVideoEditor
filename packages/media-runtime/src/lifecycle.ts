export const MEDIA_RESOURCE_TYPES = [
  "video-frame",
  "audio-data",
  "video-decoder",
  "audio-decoder",
  "video-encoder",
  "audio-encoder",
  "blob-url",
  "worker",
] as const;

export type MediaResourceType = (typeof MEDIA_RESOURCE_TYPES)[number];

export type ResourceTypeSnapshot = {
  active: number;
  created: number;
  peak: number;
  released: number;
};

export type ResourceLifecycleSnapshot = {
  activeTotal: number;
  byType: Record<MediaResourceType, ResourceTypeSnapshot>;
};

type Closeable = {
  close(): void;
};

type Terminable = {
  terminate(): void;
};

export class ResourceLease {
  private released = false;

  constructor(
    readonly id: string,
    readonly type: MediaResourceType,
    private readonly releaseResource: () => void,
    private readonly onReleased: () => void,
  ) {}

  get active(): boolean {
    return !this.released;
  }

  release(): void {
    if (this.released) {
      return;
    }
    this.released = true;
    try {
      this.releaseResource();
    } finally {
      this.onReleased();
    }
  }
}

function emptyCounts(): Record<MediaResourceType, ResourceTypeSnapshot> {
  return Object.fromEntries(
    MEDIA_RESOURCE_TYPES.map((type) => [
      type,
      { active: 0, created: 0, peak: 0, released: 0 },
    ]),
  ) as Record<MediaResourceType, ResourceTypeSnapshot>;
}

export class ResourceLifecycleTracker {
  private readonly counts = emptyCounts();
  private readonly leases = new Map<string, ResourceLease>();
  private nextId = 1;

  track(type: MediaResourceType, releaseResource: () => void): ResourceLease {
    const count = this.counts[type];
    count.active += 1;
    count.created += 1;
    count.peak = Math.max(count.peak, count.active);

    const id = `${type}:${this.nextId}`;
    this.nextId += 1;
    const lease = new ResourceLease(id, type, releaseResource, () => {
      count.active -= 1;
      count.released += 1;
      this.leases.delete(id);
    });
    this.leases.set(id, lease);
    return lease;
  }

  trackClosable(
    type: Exclude<MediaResourceType, "blob-url" | "worker">,
    resource: Closeable,
  ): ResourceLease {
    return this.track(type, () => resource.close());
  }

  trackBlobUrl(
    url: string,
    revoke: (value: string) => void = URL.revokeObjectURL.bind(URL),
  ): ResourceLease {
    return this.track("blob-url", () => revoke(url));
  }

  trackWorker(worker: Terminable): ResourceLease {
    return this.track("worker", () => worker.terminate());
  }

  releaseAll(): void {
    const leases = [...this.leases.values()];
    const errors: unknown[] = [];
    for (const lease of leases) {
      try {
        lease.release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to release media resources");
    }
  }

  snapshot(): ResourceLifecycleSnapshot {
    const byType = Object.fromEntries(
      MEDIA_RESOURCE_TYPES.map((type) => [type, { ...this.counts[type] }]),
    ) as Record<MediaResourceType, ResourceTypeSnapshot>;
    return {
      activeTotal: MEDIA_RESOURCE_TYPES.reduce(
        (total, type) => total + byType[type].active,
        0,
      ),
      byType,
    };
  }

  assertReleased(): void {
    const snapshot = this.snapshot();
    if (snapshot.activeTotal === 0) {
      return;
    }
    const active = MEDIA_RESOURCE_TYPES.filter(
      (type) => snapshot.byType[type].active > 0,
    )
      .map((type) => `${type}=${snapshot.byType[type].active}`)
      .join(", ");
    throw new Error(`Media resources are still active: ${active}`);
  }
}
