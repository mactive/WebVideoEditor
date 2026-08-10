# 兼容性、错误处理与故障排查

基准是最新稳定 Chrome/Edge。Safari/Firefox 是否支持某个 codec 由
`isConfigSupported` 实测，不按浏览器名推断，也不承诺完整导出。

## 能力矩阵的读法

| 能力               | 缺失影响              | 当前降级/处理              |
| ------------------ | --------------------- | -------------------------- |
| WebCodecs decode   | 无帧级预览/代理       | 禁用对应动作并诊断         |
| H.264/AAC encode   | 不能输出目标 MP4      | 导出前阻止，不静默换 codec |
| OPFS               | 无代理缓存/流式导出   | 生产路径报明确错误         |
| WebGL              | Pixi 预览不可用       | 能力页标记关键失败         |
| OffscreenCanvas    | Worker 导出合成不可用 | 导出失败并提示             |
| SAB / isolation    | 无共享时钟实验        | message transport 降级     |
| performance.memory | 无 heap 数字          | 显示 N/A，不判失败         |

## COOP/COEP 与 SAB

症状：`crossOriginIsolated=false`、clock transport 为 message。确认通过
`pnpm dev:editor` 或 `pnpm --filter @web-video-editor/editor preview` 访问；不要
`file://` 打开。Network 主文档响应应有：

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

跨域媒体还需允许被嵌入，否则 COEP 会拦截；本仓库 `/test_assets` 返回
`Cross-Origin-Resource-Policy: same-origin`。

## codec 不支持

症状：导出按钮禁用，或报 `avc1.640028` / `mp4a.40.2` 不支持。先在“能力”确认 decode
与 encode 是不同项，再检查系统硬件/浏览器版本。当前 Demo 不自动切 WebM，也没有
FFmpeg/WASM fallback；更改 codec 前必须同时修改能力检测、Export config、Mux 和测试。

## OPFS 与配额

UI 点“清理代理缓存”只清
`web-video-editor-media-cache-v1`。导出在 `web-video-editor-exports-v1`；成功文件保留供
下载，取消时 `.tmp-` 必须被删除。Storage N/A 只表示 estimate 不可用，不代表 OPFS
必然不可用。

## Worker / 协议故障

按日志搜索 requestId：

- `UNKNOWN_OPERATION`：主线程与 Worker 版本/operation 不一致。
- `DUPLICATE_REQUEST_ID`：调用方复用了活动 ID。
- timeout：长代理应使用 UI 已配置的 2 小时超时，不要沿用默认 30 秒。
- malformed/stale：检查 version、projectRevision；过期响应被丢弃是正常保护。
- Worker transport error：pending tasks 会失败，下一次请求会新建 Worker。

## 内存持续增长

先看 active VF/AD 与 codec queue。active 不回零时定位 `close()`/lease；队列增长时定位
背压；active 已回零但 heap 高可能只是 GC 尚未运行。取消后检查 OPFS temp 和 Blob URL。

## 复现与预期输出

```bash
pnpm verify
```

```text
UI: 缺能力时按钮禁用并显示 reason，不静默失败
Console: error 含 name/message/context、requestId/revision
CLI: 失败时 [VERIFY] Reproduce: <具体命令>
```

## 源码证据

- 能力与动作可用性：[apps/editor/src/capabilities.ts](/source/apps/editor/src/capabilities.ts.txt)
- 响应头与只读素材：[apps/editor/vite.config.ts](/source/apps/editor/vite.config.ts.txt)
- Worker 恢复：[packages/media-runtime/src/worker-client.ts](/source/packages/media-runtime/src/worker-client.ts.txt)
- OPFS 清理：[packages/media-runtime/src/proxy-cache.ts](/source/packages/media-runtime/src/proxy-cache.ts.txt)
- 导出诊断：[apps/editor/src/export/export-pipeline.ts](/source/apps/editor/src/export/export-pipeline.ts.txt)
- 资源计数：[packages/media-runtime/src/lifecycle.ts](/source/packages/media-runtime/src/lifecycle.ts.txt)
