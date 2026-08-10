# MobX 隔离对照

`/mobx.html` 的 `ClipViewModel` 只存在于实验页内。`makeAutoObservable` 追踪 x、y、
scale、rotation 和 opacity；`reaction` 记录属性变化，`observer` 触发局部 React
渲染。右侧则创建另一份 Redux Project，并且只能通过 `ProjectCommandController` 写入。

| 对比项    | MobX 实验                | 正式 Redux + Command      |
| --------- | ------------------------ | ------------------------- |
| 数据范围  | 临时 Clip ViewModel      | 整个可序列化工程          |
| 更新方式  | 调实例 action            | 发送判别联合 Command      |
| 观测      | reaction / render count  | revision / Command 日志   |
| Undo/Redo | 未提供                   | Command 事务快照          |
| 持久化    | 不持久化                 | Project JSON -> IndexedDB |
| 边界      | 不共享对象、不写 Project | 唯一正式写入口            |

这里不是证明某个状态库“更快”。实验只展示更新模型差异；仓库没有对两者做性能基准，
因此文档不声明固定倍数。

## 复现与预期输出

```bash
pnpm dev:editor
```

打开 `http://localhost:5173/mobx.html`，拖动“位置 X”一次，再点“执行 Redux Command”：

```text
UI: MobX action 0 -> 1，reaction 0 -> 1，Redux revision 保持 0
UI: 点击右侧按钮后 Redux revision 0 -> 1，左侧 action/reaction 不变
Console: 无正式 [COMMAND] 日志面板；实验通过页面计数暴露边界
CLI: Vite Local http://localhost:5173/
```

自动测试：

```bash
pnpm test
```

## 源码证据

- 独立 ViewModel 和 disposer：[apps/editor/src/mobx/ClipViewModel.ts](/source/apps/editor/src/mobx/ClipViewModel.ts.txt)
- 两种状态并列页面：[apps/editor/src/mobx/MobxExperiment.tsx](/source/apps/editor/src/mobx/MobxExperiment.tsx.txt)
- 隔离单测：[apps/editor/src/mobx/ClipViewModel.test.ts](/source/apps/editor/src/mobx/ClipViewModel.test.ts.txt)
- 正式 Redux Store：[apps/editor/src/store/store.ts](/source/apps/editor/src/store/store.ts.txt)
