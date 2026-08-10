export type PlaybackClockState = "paused" | "running";

export type PlaybackClockSnapshot = {
  state: PlaybackClockState;
  timeUs: number;
};

export type PlaybackClock = {
  readonly buffer?: SharedArrayBuffer;
  readonly degradedReason?: string;
  readonly mode: "message" | "shared";
  read(): PlaybackClockSnapshot;
  write(snapshot: PlaybackClockSnapshot): void;
};

export type SharedMemoryCapability = {
  crossOriginIsolated?: boolean;
  sharedArrayBuffer?: typeof SharedArrayBuffer;
};

const CLOCK_SEQUENCE = 0;
const CLOCK_STATE = 1;
const CLOCK_TIME_LOW = 2;
const CLOCK_TIME_HIGH = 3;
const CLOCK_HEADER_LENGTH = 4;
const UINT32_RANGE = 0x1_0000_0000;

function validateTime(timeUs: number): void {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) {
    throw new RangeError("timeUs must be a non-negative safe integer");
  }
}

function capability(options: SharedMemoryCapability): {
  available: boolean;
  reason?: string;
  sabConstructor?: typeof SharedArrayBuffer;
} {
  const isolated =
    options.crossOriginIsolated ?? globalThis.crossOriginIsolated ?? false;
  const constructor =
    options.sharedArrayBuffer ??
    (typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer);
  if (!isolated) {
    return {
      available: false,
      reason:
        "SharedArrayBuffer disabled because cross-origin isolation is unavailable",
    };
  }
  if (!constructor || typeof Atomics === "undefined") {
    return {
      available: false,
      reason: "SharedArrayBuffer or Atomics is unavailable",
    };
  }
  return { available: true, sabConstructor: constructor };
}

function encodeTime(timeUs: number): { high: number; low: number } {
  return {
    high: Math.floor(timeUs / UINT32_RANGE),
    low: timeUs % UINT32_RANGE,
  };
}

function decodeTime(high: number, low: number): number {
  return (high >>> 0) * UINT32_RANGE + (low >>> 0);
}

export class SharedPlaybackClock implements PlaybackClock {
  readonly mode = "shared" as const;
  private readonly header: Int32Array;

  constructor(readonly buffer: SharedArrayBuffer) {
    if (
      buffer.byteLength <
      CLOCK_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT
    ) {
      throw new RangeError("Shared playback clock buffer is too small");
    }
    this.header = new Int32Array(buffer, 0, CLOCK_HEADER_LENGTH);
  }

  read(): PlaybackClockSnapshot {
    for (;;) {
      const before = Atomics.load(this.header, CLOCK_SEQUENCE);
      if (before % 2 !== 0) {
        continue;
      }
      const state = Atomics.load(this.header, CLOCK_STATE);
      const low = Atomics.load(this.header, CLOCK_TIME_LOW);
      const high = Atomics.load(this.header, CLOCK_TIME_HIGH);
      const after = Atomics.load(this.header, CLOCK_SEQUENCE);
      if (before === after) {
        return {
          state: state === 1 ? "running" : "paused",
          timeUs: decodeTime(high, low),
        };
      }
    }
  }

  write(snapshot: PlaybackClockSnapshot): void {
    validateTime(snapshot.timeUs);
    const encoded = encodeTime(snapshot.timeUs);
    Atomics.add(this.header, CLOCK_SEQUENCE, 1);
    Atomics.store(this.header, CLOCK_TIME_LOW, encoded.low);
    Atomics.store(this.header, CLOCK_TIME_HIGH, encoded.high);
    Atomics.store(
      this.header,
      CLOCK_STATE,
      snapshot.state === "running" ? 1 : 0,
    );
    Atomics.add(this.header, CLOCK_SEQUENCE, 1);
    Atomics.notify(this.header, CLOCK_SEQUENCE);
  }
}

export class MessagePlaybackClock implements PlaybackClock {
  readonly mode = "message" as const;
  private snapshot: PlaybackClockSnapshot = { state: "paused", timeUs: 0 };

  constructor(
    readonly degradedReason: string,
    private readonly publish?: (snapshot: PlaybackClockSnapshot) => void,
  ) {}

  read(): PlaybackClockSnapshot {
    return { ...this.snapshot };
  }

  write(snapshot: PlaybackClockSnapshot): void {
    validateTime(snapshot.timeUs);
    this.snapshot = { ...snapshot };
    this.publish?.(this.read());
  }
}

export function createPlaybackClock(
  options: SharedMemoryCapability & {
    publishFallback?: (snapshot: PlaybackClockSnapshot) => void;
  } = {},
): PlaybackClock {
  const support = capability(options);
  if (!support.available || !support.sabConstructor) {
    return new MessagePlaybackClock(
      support.reason ?? "Shared playback clock is unavailable",
      options.publishFallback,
    );
  }
  const buffer = new support.sabConstructor(
    CLOCK_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT,
  );
  return new SharedPlaybackClock(buffer);
}

export type AudioRingBuffer = {
  readonly availableRead: number;
  readonly availableWrite: number;
  readonly buffer?: SharedArrayBuffer;
  readonly capacity: number;
  readonly channels: number;
  readonly degradedReason?: string;
  readonly mode: "message" | "shared";
  clear(): void;
  read(target: Float32Array): number;
  write(source: Float32Array): number;
};

export type AudioRingBufferFallbackMessage =
  | {
      samples: Float32Array;
      type: "write";
    }
  | {
      type: "clear";
    };

const RING_READ_INDEX = 0;
const RING_WRITE_INDEX = 1;
const RING_AVAILABLE = 2;
const RING_CLOSED = 3;
const RING_HEADER_LENGTH = 4;

function validateRing(capacity: number, channels: number): void {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(channels) || channels <= 0) {
    throw new RangeError("channels must be a positive safe integer");
  }
  if (capacity % channels !== 0) {
    throw new RangeError("capacity must contain complete audio frames");
  }
}

function copyIntoRing(
  ring: Float32Array,
  index: number,
  source: Float32Array,
  length: number,
): number {
  const firstLength = Math.min(length, ring.length - index);
  ring.set(source.subarray(0, firstLength), index);
  if (firstLength < length) {
    ring.set(source.subarray(firstLength, length), 0);
  }
  return (index + length) % ring.length;
}

function copyFromRing(
  ring: Float32Array,
  index: number,
  target: Float32Array,
  length: number,
): number {
  const firstLength = Math.min(length, ring.length - index);
  target.set(ring.subarray(index, index + firstLength), 0);
  if (firstLength < length) {
    target.set(ring.subarray(0, length - firstLength), firstLength);
  }
  return (index + length) % ring.length;
}

export class SharedAudioRingBuffer implements AudioRingBuffer {
  readonly mode = "shared" as const;
  private readonly header: Int32Array;
  private readonly samples: Float32Array;

  constructor(
    readonly buffer: SharedArrayBuffer,
    readonly capacity: number,
    readonly channels: number,
  ) {
    validateRing(capacity, channels);
    const headerBytes = RING_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT;
    const requiredBytes =
      headerBytes + capacity * Float32Array.BYTES_PER_ELEMENT;
    if (buffer.byteLength < requiredBytes) {
      throw new RangeError("Shared audio ring buffer is too small");
    }
    this.header = new Int32Array(buffer, 0, RING_HEADER_LENGTH);
    this.samples = new Float32Array(buffer, headerBytes, capacity);
  }

  get availableRead(): number {
    return Atomics.load(this.header, RING_AVAILABLE);
  }

  get availableWrite(): number {
    return this.capacity - this.availableRead;
  }

  write(source: Float32Array): number {
    const length =
      Math.floor(Math.min(source.length, this.availableWrite) / this.channels) *
      this.channels;
    if (length === 0) {
      return 0;
    }
    const index = Atomics.load(this.header, RING_WRITE_INDEX);
    const next = copyIntoRing(this.samples, index, source, length);
    Atomics.store(this.header, RING_WRITE_INDEX, next);
    Atomics.add(this.header, RING_AVAILABLE, length);
    Atomics.notify(this.header, RING_AVAILABLE);
    return length;
  }

  read(target: Float32Array): number {
    const length =
      Math.floor(Math.min(target.length, this.availableRead) / this.channels) *
      this.channels;
    if (length === 0) {
      return 0;
    }
    const index = Atomics.load(this.header, RING_READ_INDEX);
    const next = copyFromRing(this.samples, index, target, length);
    Atomics.store(this.header, RING_READ_INDEX, next);
    Atomics.sub(this.header, RING_AVAILABLE, length);
    return length;
  }

  clear(): void {
    Atomics.store(this.header, RING_READ_INDEX, 0);
    Atomics.store(this.header, RING_WRITE_INDEX, 0);
    Atomics.store(this.header, RING_AVAILABLE, 0);
    Atomics.store(this.header, RING_CLOSED, 0);
  }
}

export class MessageAudioRingBuffer implements AudioRingBuffer {
  readonly mode = "message" as const;
  private readonly samples: Float32Array;
  private readIndex = 0;
  private writeIndex = 0;
  private available = 0;

  constructor(
    readonly capacity: number,
    readonly channels: number,
    readonly degradedReason: string,
    private readonly publish?: (
      message: AudioRingBufferFallbackMessage,
    ) => void,
  ) {
    validateRing(capacity, channels);
    this.samples = new Float32Array(capacity);
  }

  get availableRead(): number {
    return this.available;
  }

  get availableWrite(): number {
    return this.capacity - this.available;
  }

  write(source: Float32Array): number {
    const length =
      Math.floor(Math.min(source.length, this.availableWrite) / this.channels) *
      this.channels;
    this.writeIndex = copyIntoRing(
      this.samples,
      this.writeIndex,
      source,
      length,
    );
    this.available += length;
    if (length > 0) {
      this.publish?.({
        samples: source.slice(0, length),
        type: "write",
      });
    }
    return length;
  }

  read(target: Float32Array): number {
    const length =
      Math.floor(Math.min(target.length, this.available) / this.channels) *
      this.channels;
    this.readIndex = copyFromRing(this.samples, this.readIndex, target, length);
    this.available -= length;
    return length;
  }

  clear(): void {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.publish?.({ type: "clear" });
  }
}

export function createAudioRingBuffer(
  capacity: number,
  channels: number,
  options: SharedMemoryCapability & {
    publishFallback?: (message: AudioRingBufferFallbackMessage) => void;
  } = {},
): AudioRingBuffer {
  validateRing(capacity, channels);
  const support = capability(options);
  if (!support.available || !support.sabConstructor) {
    return new MessageAudioRingBuffer(
      capacity,
      channels,
      support.reason ?? "Shared audio ring buffer is unavailable",
      options.publishFallback,
    );
  }
  const headerBytes = RING_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT;
  const buffer = new support.sabConstructor(
    headerBytes + capacity * Float32Array.BYTES_PER_ELEMENT,
  );
  return new SharedAudioRingBuffer(buffer, capacity, channels);
}
