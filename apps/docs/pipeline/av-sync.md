# 音频主时钟与同步

有可播放音频时，`AudioContext.currentTime` 是主时钟；无音频时才使用
`performance.now()`。`MonotonicProjectClock` 保存工程时间 anchor，保证同一播放代内时间
不倒退。SAB/message transport 只负责跨线程发布时间，不改变主时钟来源。

## 播放流程

1. 从工程时间与 Clip 边界计算 4 秒 look-ahead 音频窗口。
2. Mediabunny `AudioBufferSink` 解码与裁剪 AudioBuffer。
3. AudioBufferSourceNode 以 `AudioContext.currentTime + 60ms` 为起点排程。
4. 时钟以同一个 audio start anchor 启动，视频按工程时间请求。
5. 帧到达后比较 source timestamp、project request time 与 master time。

默认判定：帧比请求超前 `50ms` 丢弃；视频落后主时钟 `100ms` 丢弃；漂移达到
`200ms` 请求重同步。revision 或 generation 不一致无条件丢弃。

Seek、Pause、工程 revision 变化都会 generation `+1`、abort 未完成解码、stop/disconnect
所有旧 AudioBufferSourceNode。旧代音频不能继续播放，晚到帧也会被关闭。

## 复现与预期输出

```bash
pnpm --filter @web-video-editor/editor dev
```

打开 `/sync-debug.html` 或总编辑器的 `SyncDebugPanel`：

```text
UI: Clock source audio（有音频）或 performance（无音频）
UI: A/V Drift、Resync、Timestamp Drops、Audio Generation 实时更新
UI: 隔离环境 transport=shared；否则 transport=message 并显示降级原因
Console: [SEEK] request.cancelled output.activeSources=0
CLI: Vite Local http://localhost:5173/
```

自动测试：

```bash
pnpm test
```

## 源码证据

- 单调工程时钟：[packages/media-runtime/src/playback-clock.ts](/source/packages/media-runtime/src/playback-clock.ts.txt)
- 帧选择与漂移阈值：[packages/media-runtime/src/playback-sync.ts](/source/packages/media-runtime/src/playback-sync.ts.txt)
- 音频窗口、排程与失效：[packages/media-runtime/src/audio-playback.ts](/source/packages/media-runtime/src/audio-playback.ts.txt)
- 预览主时钟接入：[packages/preview-runtime/src/preview-runtime.ts](/source/packages/preview-runtime/src/preview-runtime.ts.txt)
- 同步调试 UI：[apps/editor/src/audio/SyncDebugPanel.tsx](/source/apps/editor/src/audio/SyncDebugPanel.tsx.txt)
- 同步测试：[packages/media-runtime/src/playback-sync.test.ts](/source/packages/media-runtime/src/playback-sync.test.ts.txt)
