# 统一日志与 requestId 链路

每条日志必须包含 timestamp、level、marker、scope、event；按需包含 requestId、
projectRevision、input、output、durationMs、error。Schema 拒绝 NaN、循环引用、原始二进制
和运行时对象；ArrayBuffer/TypedArray 只记录类型、长度和摘要。

## 字段如何读

- `requestId`：一次异步意图，从 UI 到 Worker/WASM/渲染保持一致。
- `projectRevision`：结果对应的工程快照；相同 requestId 但 revision 不符也必须丢弃。
- `input`：进入该阶段的最小摘要，不包含原始媒体内容。
- `output`：该阶段产物、水位、尺寸、计数。
- `durationMs`：该阶段本机耗时，不能跨机器当固定指标。
- `error`：name/message/stack/cause/context 的 JSON 序列化形式。

## Seek 链路

```text
[SEEK] request
[ECS] evaluate
[DEMUX] packet
[DECODE] frame 或 frame.dropped
[RENDER] present
```

在日志面板“搜索”输入 `preview-seek-42` 可还原顺序。Marker 下拉可隔离
`[EXPORT]`；“复制 JSONL”和“导出 JSONL”只导出当前筛选结果。Console Sink 每条输出为
单行 JSON，可用 DevTools 过滤 `"[PROXY]"`。

真实形状示例，省略了会变化的时间和耗时：

```json
{
  "level": "info",
  "marker": "[COMMAND]",
  "scope": "editor-command",
  "event": "execution.completed",
  "requestId": "drag-clip-...",
  "projectRevision": 3,
  "input": { "commandTypes": ["clip.move"], "transactionId": "drag-clip-..." },
  "output": { "afterRevision": 3, "beforeRevision": 2 }
}
```

## CLI 日志

```bash
pnpm media:probe -- test_assets/test_1.mp4
```

```text
CLI: 2026-... INFO [PROBE] media-probe-cli metadata ...
CLI: 2026-... INFO [PROBE] media-probe-cli main-track.selected ...
CLI: 2026-... INFO [PROBE] media-probe-cli capability ...
CLI: 2026-... INFO [PROBE] media-probe-cli summary ...
UI: 日志面板显示 N/N 条，支持 level/marker/scope/search
Console: 同一 LogEntry 的 JSON 版本
```

## 源码证据

- Marker/event 字典：[packages/observability/src/dictionary.ts](/source/packages/observability/src/dictionary.ts.txt)
- 严格 schema：[packages/observability/src/schema.ts](/source/packages/observability/src/schema.ts.txt)
- logger、trace、LogHub：[packages/observability/src/logger.ts](/source/packages/observability/src/logger.ts.txt)
- Worker 日志桥：[packages/observability/src/sinks/worker.ts](/source/packages/observability/src/sinks/worker.ts.txt)
- UI 筛选/JSONL：[apps/editor/src/logs/LogPanel.tsx](/source/apps/editor/src/logs/LogPanel.tsx.txt)
- CLI 输出：[packages/media-runtime/src/cli.ts](/source/packages/media-runtime/src/cli.ts.txt)
