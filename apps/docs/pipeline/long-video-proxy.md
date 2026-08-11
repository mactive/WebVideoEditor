# 长视频 Proxy 性能策略

长视频 proxy 的目标不是让用户等完整转码后才能开始编辑，而是把“能不能先动手”和
“什么时候更流畅”拆开。当前策略按素材规模和缓存状态选择路径：

| 场景 | 添加策略 | 预览路径 | 推荐动作 |
| ---- | -------- | -------- | -------- |
| 小视频，如 `test_1.mp4` | 直接添加 | 先 `source`，proxy ready 后切到 `opfs-proxy` | 不必等待 proxy |
| 长视频，如 `test_2.mp4`，proxy running | 允许立即添加 | `source` fallback，seek 可能慢 | 推荐等待关键 proxy 可用或后台预处理 |
| 长视频，OPFS cache hit | 直接添加 | 直接用缓存 proxy | 不重新生成 |
| proxy failed/cancelled | 仍可添加 | `source` fallback | 需要时重新生成或清缓存 |

因此答案是：不强制所有视频等待 proxy 完成。小视频可直接添加；长视频也允许立即添加，
但 UI 必须说明当前是 `source fallback`、`proxy running` 还是 `cache hit`。长视频若要
频繁 seek、反复预览或做较长时间编辑，等待 proxy 或先后台预处理会更稳。

## 内存占用怎么看

浏览器里没有一个数字能代表完整内存状态。排查长视频时同时看这些信号：

| 指标 | 来源 | 含义 | 注意 |
| ---- | ---- | ---- | ---- |
| 主线程 JS heap | `performance.memory` | UI 和主线程对象的大致占用 | Chromium 可用；不可用时显示 `N/A` |
| Worker heap | 浏览器不稳定暴露 | 不能可靠读取 media worker 内部 heap | 不把它伪装成精确数值 |
| OPFS committed bytes | proxy cache stats | 已完成缓存产物占用 | cache hit 应复用这部分 |
| OPFS temporary bytes/entries | proxy cache stats | 正在写入的临时事务 | 取消或失败后应回到 0 |
| Storage usage/quota | `navigator.storage.estimate()` | 站点总体存储水位 | usage 包含 OPFS 以外的站点数据 |
| 输出字节与处理媒体时间 | proxy progress payload | 判断任务是否持续推进 | 长视频优先看 `processedTimeSec / durationSec` |

健康状态不是 heap 立即下降，而是 `VideoFrame` / `AudioData` active 资源回落、队列有上限、
OPFS 临时目录被清理、`processedTimeSec` 持续推进。GC 时机由浏览器控制，所以 heap 高位
停留只能作为线索，不能单独判定泄漏。

## WebCodecs、Mediabunny、WASM、分段和预处理

| 方案 | 适合做什么 | 不适合做什么 |
| ---- | ---------- | ------------ |
| WebCodecs + Mediabunny | 视频/音频主转码路径：Mediabunny 负责容器、sample、mux，WebCodecs 负责硬件优先 decode/encode | 不能只靠 WebCodecs 解析 MP4 容器；不能假设所有浏览器都支持同一 codec |
| Rust WASM | 波形 min/max/RMS、时间换算、索引摘要、校验、分段调度计算等确定性 CPU 小算法 | 不作为 H.264/AAC 视频转码默认主路径，避免软件编解码、下载体积和线程隔离成本 |
| 分段 proxy | 长视频首段或当前时间范围先 ready，未完成范围继续 source fallback | 本次只定义接口边界，不一次性重写完整 pipeline |
| 后台预处理 | 不添加到时间线也先生成 proxy、缩略图、波形和索引，之后导入或添加直接 cache hit | 不替代取消、清理和参数化缓存键 |

项目当前主路径仍是 WebCodecs/Mediabunny。WASM 用在波形和摘要这类 CPU 逻辑上；如果未来
把 FFmpeg/WASM 作为格式兜底，需要单独评估包体、COOP/COEP、虚拟文件系统、取消清理和
codec/license，不能直接替换现有 proxy pipeline。

## OPFS 预处理缓存

proxy cache key 由素材指纹和全部生成参数计算。相同素材、相同参数再次导入时应命中 OPFS
cache；参数变化，例如长视频轻量参数或未来高质量参数，会生成不同 key，避免混用。

缓存事务先写 `.tmp-...` 临时目录，最后提交 manifest。取消、失败或初始化 cache 时会清理
遗留临时目录。需要清理或重新生成的情况：

- 用户手动点击“清理代理缓存”。
- 生成参数变化，需要新的 cache key。
- manifest 或产物缺失，cache 读取判定无效。
- 取消/失败后需要确认 temporary entries 回到 0，再重试。
- Storage usage 接近 quota，需要释放旧 proxy。

## 验证入口

```bash
pnpm docs:check
pnpm test:e2e:core
pnpm test:e2e:test2
```

`test:e2e:core` 覆盖 `test_1.mp4` 默认日志关闭、source fallback 可见、proxy ready 后不黑屏。
`test:e2e:test2` 是手动性能场景，覆盖 `test_2.mp4` Range 探测、取消清理、cache hit、
progress 中的 `durationSec / processedTimeSec / outputBytes`、主线程 heap 和 Storage
estimate 证据。

## 源码证据

- 添加与 source/proxy 切换：[apps/editor/src/App.tsx](/source/apps/editor/src/App.tsx.txt)
- 长视频轻量参数与超时：[apps/editor/src/media/MediaPanel.tsx](/source/apps/editor/src/media/MediaPanel.tsx.txt)
- Proxy 进度 UI：[apps/editor/src/media/ProxyProgress.tsx](/source/apps/editor/src/media/ProxyProgress.tsx.txt)
- Proxy payload 类型：[packages/media-runtime/src/proxy-types.ts](/source/packages/media-runtime/src/proxy-types.ts.txt)
- Proxy pipeline：[packages/media-runtime/src/proxy-pipeline.ts](/source/packages/media-runtime/src/proxy-pipeline.ts.txt)
- OPFS cache 清理：[packages/media-runtime/src/proxy-cache.ts](/source/packages/media-runtime/src/proxy-cache.ts.txt)
- `test_2` 手动性能脚本：[apps/editor/e2e/manual/test2-performance.spec.ts](/source/apps/editor/e2e/manual/test2-performance.spec.ts.txt)
