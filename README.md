# Web Video Editor Learning Demo

Task 1 提供最小可运行 workspace、React/Vite 能力检测页和 VitePress 文档站。

## 工具链

- Node.js `22.17.0`
- pnpm `10.13.1`
- Rust `1.92.0`

```bash
corepack enable
pnpm install --frozen-lockfile
```

## 常用命令

```bash
pnpm dev:editor  # http://localhost:5173
pnpm dev:docs    # http://localhost:5174
pnpm typecheck
pnpm test
pnpm build
pnpm media:probe -- test_assets/test_1.mp4
pnpm --silent media:probe -- --json test_assets/test_1.mp4
pnpm test:e2e
pnpm test:e2e:extended
pnpm test:e2e:test2
pnpm verify
```

`pnpm verify` 是统一验证入口，逐步输出命令、耗时和失败复现位置；默认 Playwright 只运行 Task 12 核心流程。`test_2.mp4` 大文件场景仅由 `pnpm test:e2e:test2` 手动触发。素材探测 CLI 默认输出结构化 `[PROBE]` 人读日志；加 `--json` 输出机器可读 JSON，配合 pnpm 时使用 `--silent` 避免生命周期日志混入 stdout。

仓库根目录的 `test_assets` 仅由编辑器开发服务通过 `/test_assets/*` 只读提供，不会复制到构建产物。
