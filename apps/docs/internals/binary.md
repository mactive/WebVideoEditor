# ArrayBuffer、TypedArray、Transferable 与 SharedArrayBuffer

## 四种语义不要混用

| 机制              | 此仓库用途                        | 所有权/复制                        |
| ----------------- | --------------------------------- | ---------------------------------- |
| Structured Clone  | 协议中的小型 JSON payload         | 结构复制                           |
| TypedArray View   | PCM、波形、WASM ABI               | 解释同一 buffer 的类型/区间        |
| Transferable      | Worker 大 ArrayBuffer、VideoFrame | 所有权转移；发送方 buffer detached |
| SharedArrayBuffer | 播放时钟、音频环形缓冲实验        | 双方共享；必须 Atomics + 隔离      |

`TransferOwnershipLedger.begin()` 在 postMessage 前记录原始 byteLength，`complete()` 要求
非空 ArrayBuffer 已变成 `byteLength === 0`。发送方后续调用 `assertOwned` 会失败，
防止把 detached buffer 当成有效数据继续使用。

WASM 输入 `&[f32]` / `&[u8]` 由 wasm-bindgen 暴露为 Float32Array / Uint8Array；波形输出
布局固定为 `[min buckets][max buckets][rms buckets]`，TS 用 `subarray` 建 view，不再次
拆成对象数组。

## SAB 时钟与降级

共享时钟用 4 个 Int32：sequence、state、time low、time high。写入前后将 sequence
变奇数/偶数；读取方只有前后 sequence 一致才接受快照。环形缓冲也只写完整声道帧。
没有 `crossOriginIsolated`、SharedArrayBuffer 或 Atomics 时，工厂返回 message 模式，
功能保留但不是共享内存。

## 复现与预期输出

```bash
pnpm test
```

```text
UI: SyncDebugPanel 显示 clockTransportMode shared；无隔离时为 message
Console: Transfer 只记录 byteLength/type，不打印原始 PCM/packet
CLI: detached buffer、SAB clock、ring buffer 测试通过
```

浏览器 Console 可验证隔离：

```js
console.log(crossOriginIsolated, typeof SharedArrayBuffer, typeof Atomics);
```

预期基准开发服务输出：

```text
true "function" "object"
```

## 源码证据

- 转移所有权账本：[packages/media-runtime/src/transfer.ts](/source/packages/media-runtime/src/transfer.ts.txt)
- SAB 时钟与环形缓冲：[packages/media-runtime/src/shared-memory.ts](/source/packages/media-runtime/src/shared-memory.ts.txt)
- 二进制日志摘要：[packages/observability/src/serialize.ts](/source/packages/observability/src/serialize.ts.txt)
- WASM TypedArray 包装：[packages/media-wasm/src/index.ts](/source/packages/media-wasm/src/index.ts.txt)
- detached/SAB 测试：[packages/media-runtime/src/shared-memory.test.ts](/source/packages/media-runtime/src/shared-memory.test.ts.txt)
