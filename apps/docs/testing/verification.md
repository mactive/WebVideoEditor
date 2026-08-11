# 自动测试、性能与内存检查

## 验证层级

| 命令                           | 覆盖                                                  | 是否进入 verify      |
| ------------------------------ | ----------------------------------------------------- | -------------------- |
| `pnpm docs:check`              | cache、日志字典、源码链接、bash、Mermaid              | 是                   |
| `pnpm test:rust` / `test:wasm` | Rust 与真实 Chrome WASM                               | 是                   |
| `pnpm test`                    | Domain、Redux、Worker、RxJS、WASM wrapper、缓存、同步 | 是                   |
| `pnpm build`                   | WASM、editor、docs 生产构建                           | 是                   |
| `pnpm test:e2e:core`           | test_1 导入/编辑/Seek/Undo/导出/内存                  | 是                   |
| `pnpm test:e2e:test2`          | 911MB 手动性能                                        | 否，避免默认 CI 过长 |

统一入口：

```bash
pnpm verify
```

步骤依次为 docs check、Prettier、ESLint、TypeScript、Rust fmt/clippy/test、Chrome WASM、
Vitest、生产构建、核心 Playwright。每步输出 START/PASS/耗时；失败输出 reproduce 命令。

## 内存不是单一 heap 数字

自动检查同时看四类证据：

1. `ResourceLifecycleTracker`：VideoFrame、AudioData、codec、Worker、Blob URL 的
   created/released/active/peak。
2. codec queue：导出 video/audio peak 不超过高水位 8。
3. `performance.memory`：Chromium 可用时记录 usedJSHeapSize，不可用时明确 N/A。
4. `navigator.storage.estimate()` 与 OPFS：usage >= 导出/缓存字节，取消后无 `.tmp-`。

核心 E2E 在快速 Seek 后轮询 VideoFrame active 回到 0；导出后断言 30 个 frame 全部释放、
AudioData active=0、最终文件可解码。它证明该场景资源闭环，不等同于所有时长都无泄漏。

## Task 6 回归证据

`test_1.mp4` 默认走核心与预览 E2E：

```bash
pnpm test:e2e:core
pnpm exec playwright test apps/editor/e2e/preview.spec.ts --grep "direct preview"
```

需要证明：

1. 日志开关初始为“日志关闭”，关闭时不再写入总日志、Console 或预览 Worker 日志回传。
2. 素材可在 proxy 未完成时添加到时间线，并先显示 direct source fallback 画面。
3. proxy ready 后 runtime source 切到 OPFS proxy，画布非黑像素仍存在，presented frames 继续推进。

`test_2.mp4` 不进入默认 verify，使用手动性能脚本：

```bash
pnpm test:e2e:test2
```

该脚本断言 Range 探测没有读完整文件、取消后 OPFS `temporaryEntries=0`、同参数第二次生成
cache hit、Storage usage 大于等于 committed bytes，并采集 proxy progress 样本证明
`durationSec`、`processedTimeSec`、`outputBytes` 可见且处理媒体时间向前推进。

## 两分钟手动检查模板

1. DevTools Performance/Memory 开启采样。
2. 播放或连续 Seek 至少 2 分钟，每 15 秒记录下表。
3. 停止、等待队列归零，再记录 30 秒后的基线。

|     时间 | heap | active VF/AD | decode/VQ/AQ | dropped/stale | OPFS | 备注 |
| -------: | ---: | ------------ | ------------ | ------------- | ---: | ---- |
|       0s |      |              |              |               |      |      |
|     120s |      |              |              |               |      |      |
| stop+30s |      |              |              |               |      |      |

健康信号是 active 资源回落、队列有上限、旧请求只增加 dropped/stale；不能只凭 heap 没有
立即下降断定泄漏，因为 GC 时机不受应用控制。

## 预期 UI / Console / CLI

```text
UI: Decode Queue 0，VF/AD 0/0，OPFS Storage 有值或 N/A
Console: frame.dropped 有明确 reason；不出现未处理 pageerror
CLI: [DOCS] PASS ...
CLI: [VERIFY] PASS <step> <seconds>s
CLI: [VERIFY] ALL PASS <seconds>s
```

## 源码证据

- 统一验证编排：[scripts/verify.mjs](/source/scripts/verify.mjs.txt)
- 文档校验：[scripts/verify-docs.mjs](/source/scripts/verify-docs.mjs.txt)
- 静态源码生成：[scripts/generate-doc-sources.mjs](/source/scripts/generate-doc-sources.mjs.txt)
- 资源计数器：[packages/media-runtime/src/lifecycle.ts](/source/packages/media-runtime/src/lifecycle.ts.txt)
- heap/storage 采样：[packages/media-runtime/src/runtime-metrics.ts](/source/packages/media-runtime/src/runtime-metrics.ts.txt)
- 核心浏览器断言：[apps/editor/e2e/task12-core.spec.ts](/source/apps/editor/e2e/task12-core.spec.ts.txt)
- 手动性能说明：[apps/editor/e2e/manual/README.md](/source/apps/editor/e2e/manual/README.md.txt)
