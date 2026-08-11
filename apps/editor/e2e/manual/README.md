# test_2 手动性能场景

该目录不进入默认 `pnpm verify` 或 `pnpm test:e2e`。运行：

```bash
pnpm test:e2e:test2
```

脚本使用真实 Chromium、Media Worker 和 `/test_assets/test_2.mp4`，依次执行：

1. 清理代理缓存并通过 HTTP Range 流式探测大文件。
2. 记录读取字节比例、探测耗时和 `performance.memory` 可用指标。
3. 启动短代理后取消，等待 OPFS 临时目录归零。
4. 以同一参数生成 2 秒短代理，采集 progress 的 `durationSec`、
   `processedTimeSec`、`outputBytes`，确认处理媒体时间推进。
5. 再次请求并验证 cache hit。
6. 对照缓存目录字节数与 `navigator.storage.estimate()` 的站点用量。

失败会定位到 Playwright 断言或带 requestId 的 Worker 错误。成功日志以
`[TASK12_TEST2]` 输出本次实测数据，不声明固定性能倍数。`performance.memory` 或
`navigator.storage.estimate()` 不可用时应显式显示或记录 `N/A`，不要推断 Worker heap。
