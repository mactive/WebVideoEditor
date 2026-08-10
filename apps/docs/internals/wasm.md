# Rust WASM 构建、ABI 与实测

WASM 只承担确定性 CPU 任务，不重复实现 WebCodecs：

- 秒、微秒、帧号换算，包含 30000/1001 帧率。
- 增量 PCM min/max/RMS 波形。
- Uint8Array 的长度、FNV-1a 32 位摘要、min/max/xor。

## 构建与 ABI

```bash
pnpm build:wasm
pnpm build:wasm:node
pnpm test:rust
pnpm test:wasm
```

`wasm-pack --target web` 生成 `pkg/media_wasm.js`、`.d.ts`、`.wasm`；Node 基准用
`pkg-node`。Rust 的 `Result<f64, JsError>` 在 JS 侧表现为 number 或异常；
`PcmWaveformAccumulator` 是显式 `new/push/finish/free` 生命周期。TS 包装器的
`dispose()` 必须调用 `free()`。

## 2026-08-09 本机实测

命令：

```bash
pnpm bench:wasm
```

本轮环境为 Apple Silicon macOS、Node `22.17.0`、Rust `1.92.0`、wasm-pack `0.15.0`。
以下是命令原样摘要，不是跨机器承诺：

```text
[WASM BENCH] Rust native:
timeline iterations=100 duration_ms=0.000
waveform samples=48000 buckets=1000 iterations=100 duration_ms=17.238
bytes=1048576 iterations=100 duration_ms=113.494

[WASM BENCH] Node WASM:
timeline iterations=100 duration_ms=0.210
waveform samples=48000 buckets=1000 iterations=100 duration_ms=25.897
summary bytes=1048576 iterations=100 duration_ms=121.636
```

这里不能据此声称 WASM 比 JS 或原生快多少：基准只比较本仓库 Rust native 与 Node WASM
实现，且样本、JIT、硬件固定。代理流水线会额外输出每个 `[WASM]` 调用的真实 durationMs。

## 预期 UI / Console / CLI

```text
UI: 代理完成后显示 512 waveform buckets
Console: [WASM] waveform.completed input.samples=<实际样本数>
         output.buckets=512 output.type=Float32Array
CLI: wasm-pack build Done；Rust test、Chrome wasm-bindgen test 通过
```

## 源码证据

- Rust 导出与布局：[packages/media-wasm/crate/src/lib.rs](/source/packages/media-wasm/crate/src/lib.rs.txt)
- TS ABI 和性能日志：[packages/media-wasm/src/index.ts](/source/packages/media-wasm/src/index.ts.txt)
- Rust 基准：[packages/media-wasm/crate/benches/sdk.rs](/source/packages/media-wasm/crate/benches/sdk.rs.txt)
- Node WASM 基准：[packages/media-wasm/bench/run.mjs](/source/packages/media-wasm/bench/run.mjs.txt)
- 浏览器测试：[packages/media-wasm/crate/tests/web.rs](/source/packages/media-wasm/crate/tests/web.rs.txt)
- 代理调用点：[packages/media-runtime/src/proxy-pipeline.ts](/source/packages/media-runtime/src/proxy-pipeline.ts.txt)
