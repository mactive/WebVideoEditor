# 浏览器能力检测

编辑器启动时执行真实能力探测，并在页面和 Console 中展示同一份结果。检测不依赖 User-Agent 推断。

## 检测项

| 分类                   | 检测方式                           | 影响                        |
| ---------------------- | ---------------------------------- | --------------------------- |
| WebCodecs              | 检查四类 codec API                 | 决定帧级媒体处理是否可用    |
| H.264 / AAC            | 调用 `isConfigSupported`           | 决定 MP4 预览和首选导出配置 |
| Worker                 | 创建并终止 Module Worker           | 决定媒体任务能否移出主线程  |
| OPFS                   | 获取根目录句柄                     | 决定代理和大缓存能否持久化  |
| WebGL / WebGPU         | 创建 context 或请求 adapter        | 决定预览合成后端            |
| OffscreenCanvas        | 创建 2D context                    | 决定画布工作能否移到后台    |
| SharedArrayBuffer      | 联合检查构造器、Atomics 和隔离状态 | 决定共享时钟实验是否可用    |
| Cross-origin isolation | 读取 `crossOriginIsolated`         | 验证 COOP/COEP 是否生效     |

关键能力缺失时，对应操作入口会禁用，并给出影响和处理建议。WebGPU 和 OffscreenCanvas 缺失时存在明确回退路径，不会错误阻止整个编辑器外壳。

## 隔离响应头

编辑器开发和预览服务返回：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

因此 localhost 下 `crossOriginIsolated` 应为 `true`。直接打开生产 HTML 文件不会携带响应头，共享内存实验会降级到消息传递。

## 测试素材

开发服务以只读方式映射仓库根目录的 `test_assets`：

```text
GET /test_assets/test_1.mp4
HEAD /test_assets/test_1.mp4
Range: bytes=0-1023
```

仅允许 `GET` 和 `HEAD`，写方法返回 `405`。服务支持 Range 请求，后续媒体任务无需先读取完整大文件。原始素材不会被复制或修改。

## Console 日志

检测完成后输出一条可直接 `JSON.parse` 的结构化日志。`capability.detected` 是
`[CAPABILITY]` 当前唯一事件：表示全部单项检测和动作可用性计算均已结束。

```json
{
  "timestamp": "2026-08-09T12:00:00.000Z",
  "level": "info",
  "marker": "[CAPABILITY]",
  "scope": "editor-bootstrap",
  "event": "capability.detected",
  "input": {
    "secureContext": true,
    "userAgent": "Chrome"
  },
  "output": {
    "actions": [],
    "capabilities": []
  },
  "durationMs": 12.34,
  "error": null
}
```

字段名以当前实现为准，时间和 `durationMs` 不应与示例逐字比较。

## 复现与预期输出

```bash
pnpm dev:editor
```

打开 `http://localhost:5173`，点“能力”。基准 Chromium 中预期看到 12 个
`data-capability-id` 项；核心 E2E 明确断言 `crossOriginIsolated`、`worker`、`opfs`、
`h264Decode`、`h264Encode`、`aacEncode` 为 `true`。若机器 codec 不同，应以 UI
诊断为准，不能把文档示例当成能力保证。

```text
UI: Cross-origin isolation: YES
UI: Module Worker: YES
Console: {"marker":"[CAPABILITY]","event":"capability.detected",...}
CLI: Vite dev server ready at http://localhost:5173
```

## 源码证据

- 真实 API 探测与动作禁用：[apps/editor/src/capabilities.ts](/source/apps/editor/src/capabilities.ts.txt)
- COOP/COEP、只读 Range 服务：[apps/editor/vite.config.ts](/source/apps/editor/vite.config.ts.txt)
- UI 能力面板：[apps/editor/src/App.tsx](/source/apps/editor/src/App.tsx.txt)
- 响应头与能力 E2E：[apps/editor/e2e/task12-core.spec.ts](/source/apps/editor/e2e/task12-core.spec.ts.txt)

继续阅读[兼容性与故障排查](/troubleshooting)可定位每个失败项。
