# 三个测试素材逐步实验

素材只读，位于 `test_assets/`。先记录环境，避免把不同机器结果混在一起：

```text
日期:
OS / CPU / RAM:
Chrome/Edge 版本:
Node / pnpm / Rust:
crossOriginIsolated:
H.264 decode/encode, AAC encode:
冷缓存还是热缓存:
```

## 共同准备

```bash
pnpm media:probe -- --json test_assets/test_1.mp4 test_assets/test_2.mp4 test_assets/test_3.mp4
pnpm dev:editor
```

2026-08-09 本机 CLI 实测（Node 下 `decodable=false` 是因为没有浏览器 WebCodecs）：

| 素材   | 主视频/音频                                   | 时长、大小               | CLI 唯一读取 | 比例     |
| ------ | --------------------------------------------- | ------------------------ | ------------ | -------- |
| test_1 | AVC High 720×720 30fps / AAC LC 48kHz 2ch     | 36.053s / 2,879,822B     | 323,918B     | 0.112478 |
| test_2 | AVC High 1920×1080 30fps / AAC LC 44.1kHz 2ch | 3207.930s / 911,401,782B | 3,990,326B   | 0.004378 |
| test_3 | AVC High 1080×1920 30fps / AAC LC 48kHz 2ch   | 125.021s / 141,746,939B  | 327,680B     | 0.002312 |

这些读取量是当次 Mediabunny/文件布局实测，不是恒定上限。

## 实验一：test_1 快速闭环

1. 点 `test_1.mp4`，确认主轨为 AVC 720×720，排除项显示 MJPEG/JPEG cover。
2. 点“添加到时间线”，裁剪源入点 `0.5s`、出点 `1.1s`。
3. 选“复古”，强度 `0.8`；添加标题 `TASK 13`，结束时间 `0.6s`。
4. 快速拖动预览播放头，最后停在 `0.25s`。
5. Undo/Redo 标题结束时间，最后导出。

```text
UI: Project revision 递增；最终导出 1.0s、30 帧、1920×1080
Console: [IMPORT]/[COMMAND]/[ECS]/[RENDER]/[EXPORT]
CLI: 若运行核心 E2E，30 VideoFrame created/released，active=0
```

## 实验二：test_2 大文件、取消与缓存

不要在 UI 直接等待 53 分钟全长代理。仓库提供 2 秒、320×180、15fps 的手动性能场景：

```bash
pnpm test:e2e:test2
```

它清缓存、Range 探测、开始代理后取消、确认 temp=0、生成短代理、再次请求并确认 hit。

```text
预期断言: fullFileRead=false，readRatio<0.02
预期断言: afterCancel.temporaryEntries=0
预期断言: first.cache.status=miss，second.cache.status=hit
CLI: [TASK12_TEST2] {"probeBytes":...,"probeMs":...,"firstProxyMs":...}
```

记录当次日志，不填写预设数字：

| 指标                          | 冷缓存 | 热缓存 | 说明               |
| ----------------------------- | -----: | -----: | ------------------ |
| probeBytes / readRatio        |        |        | `[TASK12_TEST2]`   |
| probeMs                       |        |        | 同一浏览器进程     |
| firstProxyMs / secondProxyMs  |        |        | 仅比较本轮         |
| cacheBytes / temporaryEntries |        |        | 取消后 temp 必须 0 |
| heapBytes / OPFS usage        |        |        | 指标不可用时写 N/A |

## 实验三：test_3 竖屏与画布

1. 点 `test_3.mp4`，确认显示尺寸 1080×1920、rotation `0°`。
2. 首次导入 `test_3.mp4` 时，若当前为空工程且仍是默认画布，Project canvas 会从 1920×1080 重设为 1080×1920。
3. 添加到时间线，确认预览代理画布为 304×540。
4. 已有工程（已有素材或画布已非默认值）及后续导入的素材不会重置 Project canvas。素材始终按当前画布使用 contain/fit 策略：保持宽高比并居中完整显示，不拉伸、不裁切，未覆盖区域由工程背景色补齐。
5. 裁剪 2 秒片段，加标题和灰度滤镜后导出并重新导入。导出分辨率由独立的 `exportSettings` 决定，不等同于 Project canvas。

```text
UI: 素材卡 1080×1920；Project canvas 1080×1920
UI: 预览代理画布 304×540
行为: 后续导入 test_1.mp4 后，Project canvas 仍为 1080×1920
CLI: 探测 excludedVideoTracks=[]，uniqueBytesRead=327680（本轮实测）
```

## 通用性能记录模板

| 阶段   | requestId | revision | 输入摘要        | 输出摘要        | durationMs | 队列/资源      | 结论 |
| ------ | --------- | -------: | --------------- | --------------- | ---------: | -------------- | ---- |
| Probe  |           |          | fileSize        | uniqueBytesRead |            | heap           |      |
| Proxy  |           |          | source WxH      | proxy bytes     |            | temp entries   |      |
| Seek   |           |          | playheadUs      | frame timestamp |            | decodeQueue/VF |      |
| Export |           |          | source=original | frames/bytes    |            | VQ/AQ/VF/AD    |      |

## 源码证据

- CLI 探测实现：[packages/media-runtime/src/cli.ts](/source/packages/media-runtime/src/cli.ts.txt)
- 固定素材基线测试：[packages/media-runtime/src/probe.test.ts](/source/packages/media-runtime/src/probe.test.ts.txt)
- 核心 test_1 流程：[apps/editor/e2e/task12-core.spec.ts](/source/apps/editor/e2e/task12-core.spec.ts.txt)
- test_2 手动场景：[apps/editor/e2e/manual/test2-performance.spec.ts](/source/apps/editor/e2e/manual/test2-performance.spec.ts.txt)
- test_3 竖屏验收：[apps/editor/e2e/task17.spec.ts](/source/apps/editor/e2e/task17.spec.ts.txt)
- 代理尺寸算法：[packages/media-runtime/src/proxy-types.ts](/source/packages/media-runtime/src/proxy-types.ts.txt)
