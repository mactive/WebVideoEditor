# Project Document、Redux、Command 与 Undo/Redo

## 四层职责

1. `ProjectDocument` 保存 schemaVersion、revision、Asset、Track、Clip、Text、Canvas 和导出设置。
2. Zod schema 负责形状，领域校验负责引用、边界、ID 唯一和同轨不重叠。
3. `CommandBus` 是正式工程唯一写入口，命令前后都校验，成功后 revision `+1`。
4. Redux 保存已提交的 Project 和短期 Editor Session；IndexedDB 只持久化序列化 JSON。

```mermaid
flowchart LR
  INPUT["UI edit"] --> COMMAND["ProjectCommand"]
  COMMAND --> CHECK1["validate before"]
  CHECK1 --> CLONE["structuredClone"]
  CLONE --> APPLY["apply command"]
  APPLY --> REV["revision + 1"]
  REV --> CHECK2["validate after"]
  CHECK2 --> HISTORY["transaction history"]
  HISTORY --> REDUX["projectCommitted"]
  REDUX --> IDB["250ms autosave JSON"]
```

连续拖动复用同一个 `transactionId`。`CommandBus` 保留第一次 `before` 和最后一次
`after`，因此数十次 pointer move 只产生一个 Undo 步骤。Undo/Redo 恢复历史快照，
不是执行猜测性的反命令。

## 不进入 Redux 的对象

`File`、`Blob`、ArrayBuffer/TypedArray、VideoFrame、AudioData、codec、Worker、
Canvas、GPU/Pixi 对象均不进入 Project。Project 只保留素材指纹、轨 ID 和小型元数据；
刷新后若原始 File 不可恢复，导出入口会报告“缺少原素材 source”。

## 复现与预期输出

```bash
pnpm test
```

在 UI 导入素材并拖动片段，然后点一次 Undo：

```text
UI: REV 每次合法 Command 递增；Undo 恢复该事务前的 revision 快照
UI: Project JSON 可 JSON.stringify，且不出现 File/Blob/VideoFrame
Console: {"marker":"[COMMAND]","event":"execution.completed",
          "input":{"transactionId":"drag-..."},
          "output":{"beforeRevision":2,"afterRevision":3}}
CLI: Vitest 中 commands/document/store/persistence 用例通过
```

## 源码证据

- Project 默认值和三条轨：[packages/domain/src/project.ts](/source/packages/domain/src/project.ts.txt)
- schema 类型：[packages/domain/src/schema.ts](/source/packages/domain/src/schema.ts.txt)
- 引用与非重叠校验：[packages/domain/src/validation.ts](/source/packages/domain/src/validation.ts.txt)
- 命令实现：[packages/domain/src/commands.ts](/source/packages/domain/src/commands.ts.txt)
- 事务、Undo/Redo：[packages/domain/src/command-bus.ts](/source/packages/domain/src/command-bus.ts.txt)
- Redux 适配：[apps/editor/src/store/commandController.ts](/source/apps/editor/src/store/commandController.ts.txt)
- IndexedDB 自动保存：[apps/editor/src/store/persistence.ts](/source/apps/editor/src/store/persistence.ts.txt)
- 拖动事务 ID：[apps/editor/src/timeline/Timeline.tsx](/source/apps/editor/src/timeline/Timeline.tsx.txt)
