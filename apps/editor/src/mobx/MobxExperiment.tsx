import { createProjectDocument } from "@web-video-editor/domain";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { ProjectCommandController, createEditorStore } from "../store";
import { ClipViewModel } from "./ClipViewModel";
import "./MobxExperiment.css";

declare global {
  interface Window {
    __TASK_10_MOBX__?: {
      getMobx(): ReturnType<ClipViewModel["snapshot"]>;
      getReduxRevision(): number;
    };
  }
}

const ClipExperiment = observer(function ClipExperiment({
  viewModel,
}: {
  viewModel: ClipViewModel;
}) {
  const renderCount = useRef(0);
  renderCount.current += 1;
  const fields = [
    {
      label: "位置 X",
      max: 1,
      min: 0,
      set: viewModel.setX,
      step: 0.01,
      value: viewModel.x,
    },
    {
      label: "位置 Y",
      max: 1,
      min: 0,
      set: viewModel.setY,
      step: 0.01,
      value: viewModel.y,
    },
    {
      label: "缩放",
      max: 3,
      min: 0.1,
      set: viewModel.setScale,
      step: 0.01,
      value: viewModel.scale,
    },
    {
      label: "旋转",
      max: 180,
      min: -180,
      set: viewModel.setRotation,
      step: 1,
      value: viewModel.rotationDeg,
    },
    {
      label: "透明度",
      max: 1,
      min: 0,
      set: viewModel.setOpacity,
      step: 0.01,
      value: viewModel.opacity,
    },
  ];

  return (
    <section className="mobx-card" aria-label="MobX Clip ViewModel">
      <header>
        <span>MOBX · ISOLATED VIEWMODEL</span>
        <strong>属性级响应</strong>
      </header>
      <div className="mobx-stage">
        <div
          data-testid="mobx-clip"
          style={{
            opacity: viewModel.opacity,
            transform: `translate(${(viewModel.x - 0.5) * 180}px, ${(viewModel.y - 0.5) * 90}px) scale(${viewModel.scale}) rotate(${viewModel.rotationDeg}deg)`,
          }}
        >
          CLIP VM
        </div>
      </div>
      <div className="mobx-fields">
        {fields.map((field) => (
          <label key={field.label}>
            {field.label} <output>{field.value.toFixed(2)}</output>
            <input
              aria-label={`MobX ${field.label}`}
              max={field.max}
              min={field.min}
              onChange={(event) => field.set(Number(event.currentTarget.value))}
              step={field.step}
              type="range"
              value={field.value}
            />
          </label>
        ))}
      </div>
      <dl className="mobx-counters">
        <div>
          <dt>action</dt>
          <dd data-testid="mobx-action-count">{viewModel.actionCount}</dd>
        </div>
        <div>
          <dt>reaction</dt>
          <dd data-testid="mobx-reaction-count">{viewModel.reactionCount}</dd>
        </div>
        <div>
          <dt>React render</dt>
          <dd data-testid="mobx-render-count">{renderCount.current}</dd>
        </div>
      </dl>
      <p>
        {viewModel.lastAction} · reaction {viewModel.lastReaction}
      </p>
    </section>
  );
});

export function MobxExperiment() {
  const viewModel = useMemo(() => new ClipViewModel(), []);
  const store = useMemo(
    () =>
      createEditorStore(
        createProjectDocument({
          id: "mobx-comparison",
          name: "Redux Command 对照",
        }),
      ),
    [],
  );
  const controller = useMemo(
    () => new ProjectCommandController(store),
    [store],
  );
  const revision = useSyncExternalStore(
    store.subscribe,
    () => store.getState().project.document.revision,
  );

  useEffect(() => {
    window.__TASK_10_MOBX__ = {
      getMobx: () => viewModel.snapshot(),
      getReduxRevision: () => store.getState().project.document.revision,
    };
    return () => {
      delete window.__TASK_10_MOBX__;
      viewModel.dispose();
    };
  }, [store, viewModel]);

  return (
    <main className="mobx-page">
      <header className="mobx-page__header">
        <div>
          <p className="eyebrow">TASK 10 · STATE MODEL LAB</p>
          <h1>MobX Clip ViewModel 对照实验</h1>
          <p>
            左侧只修改临时 ViewModel；右侧 Redux Project 只接受 Command
            Bus。两者不共享对象，也不互相写入。
          </p>
        </div>
        <a href="/">返回总编辑器</a>
      </header>

      <div className="mobx-grid">
        <ClipExperiment viewModel={viewModel} />
        <section className="mobx-card" aria-label="Redux Command 对照">
          <header>
            <span>REDUX · COMMAND BUS</span>
            <strong>工程级事务</strong>
          </header>
          <pre>{`controller.execute({
  type: "text.add",
  text: { ...serializableProjectData }
});`}</pre>
          <dl className="mobx-counters">
            <div>
              <dt>Project revision</dt>
              <dd data-testid="redux-revision">{revision}</dd>
            </div>
          </dl>
          <button
            onClick={() =>
              controller.execute({
                text: {
                  color: "#ffffff",
                  endUs: 2_000_000,
                  fontSize: 48,
                  id: `redux-title-${revision}`,
                  rotationDeg: 0,
                  scale: 1,
                  startUs: 0,
                  text: "Redux Command",
                  trackId: "text-track",
                  x: 0.5,
                  y: 0.5,
                },
                type: "text.add",
              })
            }
            type="button"
          >
            执行 Redux Command
          </button>
          <p>
            调整左侧属性时，此 revision 必须保持不变；只有此按钮能修改对照
            Project。
          </p>
        </section>
      </div>
    </main>
  );
}
