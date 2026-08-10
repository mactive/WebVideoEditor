export type TransferOwnershipRecord = {
  byteLength: number;
  requestId: string;
  status: "transferred";
  type: "ArrayBuffer";
};

type PendingTransfer = {
  buffer: ArrayBuffer;
  byteLength: number;
};

export class TransferOwnershipLedger {
  private readonly ownership = new WeakMap<
    ArrayBuffer,
    TransferOwnershipRecord
  >();
  private readonly history: TransferOwnershipRecord[] = [];

  begin(
    requestId: string,
    transfer: readonly Transferable[],
  ): readonly PendingTransfer[] {
    const pending: PendingTransfer[] = [];
    const current = new Set<ArrayBuffer>();
    for (const item of transfer) {
      if (!(item instanceof ArrayBuffer)) {
        continue;
      }
      if (current.has(item)) {
        throw new Error(
          `ArrayBuffer appears more than once in the transfer list for ${requestId}`,
        );
      }
      if (this.ownership.has(item)) {
        throw new Error(
          `ArrayBuffer ownership was already transferred for ${requestId}`,
        );
      }
      current.add(item);
      pending.push({ buffer: item, byteLength: item.byteLength });
    }
    return pending;
  }

  complete(requestId: string, pending: readonly PendingTransfer[]): void {
    for (const item of pending) {
      if (item.byteLength > 0 && item.buffer.byteLength !== 0) {
        throw new Error(
          `ArrayBuffer for ${requestId} was not detached by postMessage`,
        );
      }
      const record: TransferOwnershipRecord = {
        byteLength: item.byteLength,
        requestId,
        status: "transferred",
        type: "ArrayBuffer",
      };
      this.ownership.set(item.buffer, record);
      this.history.push(record);
    }
  }

  assertOwned(buffer: ArrayBuffer): void {
    const record = this.ownership.get(buffer);
    if (record) {
      throw new Error(
        `ArrayBuffer ownership belongs to worker request ${record.requestId}`,
      );
    }
  }

  recordFor(buffer: ArrayBuffer): TransferOwnershipRecord | undefined {
    return this.ownership.get(buffer);
  }

  records(): readonly TransferOwnershipRecord[] {
    return this.history.map((record) => ({ ...record }));
  }
}
