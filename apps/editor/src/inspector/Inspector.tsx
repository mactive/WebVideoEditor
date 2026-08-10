import type {
  Effect,
  ProjectCommand,
  ProjectDocument,
} from "@web-video-editor/domain";
import { useRef } from "react";

import "./Inspector.css";

export type InspectorProps = {
  onExecute(command: ProjectCommand, transactionId?: string): void;
  project: ProjectDocument;
  selectedClipId: string | null;
  selectedTextId: string | null;
};

function seconds(valueUs: number): number {
  return Math.round(valueUs / 1_000) / 1_000;
}

function microseconds(value: string): number {
  return Math.max(0, Math.round(Number(value) * 1_000_000));
}

export function Inspector({
  onExecute,
  project,
  selectedClipId,
  selectedTextId,
}: InspectorProps) {
  const transactions = useRef(new Map<string, string>());
  const clip = project.clips.find(
    (candidate) => candidate.id === selectedClipId,
  );
  const text = project.texts.find(
    (candidate) => candidate.id === selectedTextId,
  );
  const asset = project.assets.find(
    (candidate) => candidate.id === clip?.assetId,
  );
  const effect = clip?.effects.find(
    (candidate) => candidate.id === "clip-filter",
  );

  const transaction = (field: string): string => {
    const current = transactions.current.get(field);
    if (current) {
      return current;
    }
    const next = `inspector-${field}-${crypto.randomUUID()}`;
    transactions.current.set(field, next);
    return next;
  };
  const endTransaction = (field: string) => {
    transactions.current.delete(field);
  };

  const updateText = (
    field: string,
    patch: Extract<ProjectCommand, { type: "text.update" }>["patch"],
  ) => {
    if (!text) {
      return;
    }
    onExecute(
      { patch, textId: text.id, type: "text.update" },
      transaction(`text-${text.id}-${field}`),
    );
  };
  const setEffect = (next: Effect | null, field: string) => {
    if (!clip) {
      return;
    }
    onExecute(
      {
        clipId: clip.id,
        effect: next,
        effectId: "clip-filter",
        type: "effect.set",
      },
      transaction(`effect-${clip.id}-${field}`),
    );
  };
  const updateClipTransform = (
    field: string,
    patch: Partial<NonNullable<ProjectDocument["clips"][number]["transform"]>>,
  ) => {
    if (!clip) {
      return;
    }
    onExecute(
      {
        clipId: clip.id,
        transform: {
          rotationDeg: 0,
          scale: 1,
          x: 0.5,
          y: 0.5,
          ...clip.transform,
          ...patch,
        },
        type: "clip.transform",
      },
      transaction(`transform-${clip.id}-${field}`),
    );
  };

  if (!clip && !text) {
    return (
      <aside className="inspector" aria-label="属性面板">
        <div className="inspector__heading">
          <span>INSPECTOR</span>
          <strong>未选择对象</strong>
        </div>
        <p className="inspector__empty">
          从时间线选择视频片段或标题以编辑属性。
        </p>
      </aside>
    );
  }

  return (
    <aside className="inspector" aria-label="属性面板">
      <div className="inspector__heading">
        <span>INSPECTOR</span>
        <strong>{clip ? asset?.name : "标题"}</strong>
      </div>

      {clip ? (
        <>
          <fieldset>
            <legend>片段时间</legend>
            <label>
              时间线起点（秒）
              <input
                min={0}
                onBlur={() => endTransaction(`clip-${clip.id}-timeline`)}
                onChange={(event) =>
                  onExecute(
                    {
                      clipId: clip.id,
                      timelineStartUs: microseconds(event.currentTarget.value),
                      type: "clip.move",
                    },
                    transaction(`clip-${clip.id}-timeline`),
                  )
                }
                step={0.01}
                type="number"
                value={seconds(clip.timelineStartUs)}
              />
            </label>
            <label>
              源入点（秒）
              <input
                min={0}
                onBlur={() => endTransaction(`clip-${clip.id}-source-start`)}
                onChange={(event) =>
                  onExecute(
                    {
                      clipId: clip.id,
                      sourceEndUs: clip.sourceEndUs,
                      sourceStartUs: microseconds(event.currentTarget.value),
                      timelineStartUs: clip.timelineStartUs,
                      type: "clip.trim",
                    },
                    transaction(`clip-${clip.id}-source-start`),
                  )
                }
                step={0.01}
                type="number"
                value={seconds(clip.sourceStartUs)}
              />
            </label>
            <label>
              源出点（秒）
              <input
                max={asset ? seconds(asset.durationUs) : undefined}
                min={0.1}
                onBlur={() => endTransaction(`clip-${clip.id}-source-end`)}
                onChange={(event) =>
                  onExecute(
                    {
                      clipId: clip.id,
                      sourceEndUs: microseconds(event.currentTarget.value),
                      sourceStartUs: clip.sourceStartUs,
                      timelineStartUs: clip.timelineStartUs,
                      type: "clip.trim",
                    },
                    transaction(`clip-${clip.id}-source-end`),
                  )
                }
                step={0.01}
                type="number"
                value={seconds(clip.sourceEndUs)}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>片段变换</legend>
            {(
              [
                ["x", "片段位置 X", 0, 1, 0.01, 0.5],
                ["y", "片段位置 Y", 0, 1, 0.01, 0.5],
                ["scale", "片段缩放", 0.1, 4, 0.01, 1],
                ["rotationDeg", "片段旋转", -180, 180, 1, 0],
              ] as const
            ).map(([field, label, min, max, step, fallback]) => (
              <label key={field}>
                {label} {clip.transform?.[field] ?? fallback}
                <input
                  aria-label={label}
                  max={max}
                  min={min}
                  onBlur={() => endTransaction(`transform-${clip.id}-${field}`)}
                  onChange={(event) =>
                    updateClipTransform(field, {
                      [field]: Number(event.currentTarget.value),
                    })
                  }
                  step={step}
                  type="range"
                  value={clip.transform?.[field] ?? fallback}
                />
              </label>
            ))}
          </fieldset>

          <fieldset>
            <legend>Clip 滤镜</legend>
            <label>
              类型
              <select
                aria-label="滤镜类型"
                onChange={(event) => {
                  const kind = event.currentTarget.value;
                  endTransaction(`effect-${clip.id}-kind`);
                  if (kind === "none") {
                    setEffect(null, "kind");
                  } else if (kind === "adjustments") {
                    setEffect(
                      {
                        brightness: 0,
                        contrast: 0,
                        enabled: true,
                        id: "clip-filter",
                        kind,
                      },
                      "kind",
                    );
                  } else {
                    setEffect(
                      {
                        amount: 0.6,
                        enabled: true,
                        id: "clip-filter",
                        kind: kind as "grayscale" | "vintage",
                      },
                      "kind",
                    );
                  }
                }}
                value={effect?.kind ?? "none"}
              >
                <option value="none">无</option>
                <option value="grayscale">灰度</option>
                <option value="vintage">复古</option>
                <option value="adjustments">亮度 / 对比度</option>
              </select>
            </label>
            {effect?.kind === "grayscale" || effect?.kind === "vintage" ? (
              <label>
                强度 {Math.round(effect.amount * 100)}%
                <input
                  aria-label="滤镜强度"
                  max={1}
                  min={0}
                  onBlur={() => endTransaction(`effect-${clip.id}-amount`)}
                  onChange={(event) =>
                    setEffect(
                      { ...effect, amount: Number(event.currentTarget.value) },
                      "amount",
                    )
                  }
                  step={0.01}
                  type="range"
                  value={effect.amount}
                />
              </label>
            ) : null}
            {effect?.kind === "adjustments" ? (
              <>
                <label>
                  亮度 {effect.brightness.toFixed(2)}
                  <input
                    aria-label="亮度"
                    max={1}
                    min={-1}
                    onBlur={() =>
                      endTransaction(`effect-${clip.id}-brightness`)
                    }
                    onChange={(event) =>
                      setEffect(
                        {
                          ...effect,
                          brightness: Number(event.currentTarget.value),
                        },
                        "brightness",
                      )
                    }
                    step={0.01}
                    type="range"
                    value={effect.brightness}
                  />
                </label>
                <label>
                  对比度 {effect.contrast.toFixed(2)}
                  <input
                    aria-label="对比度"
                    max={1}
                    min={-1}
                    onBlur={() => endTransaction(`effect-${clip.id}-contrast`)}
                    onChange={(event) =>
                      setEffect(
                        {
                          ...effect,
                          contrast: Number(event.currentTarget.value),
                        },
                        "contrast",
                      )
                    }
                    step={0.01}
                    type="range"
                    value={effect.contrast}
                  />
                </label>
              </>
            ) : null}
          </fieldset>
        </>
      ) : null}

      {text ? (
        <>
          <fieldset>
            <legend>标题</legend>
            <label>
              文本
              <textarea
                aria-label="标题文本"
                onBlur={() => endTransaction(`text-${text.id}-text`)}
                onChange={(event) =>
                  updateText("text", { text: event.currentTarget.value })
                }
                value={text.text}
              />
            </label>
            <label>
              字号
              <input
                aria-label="标题字号"
                min={1}
                onBlur={() => endTransaction(`text-${text.id}-fontSize`)}
                onChange={(event) =>
                  updateText("fontSize", {
                    fontSize: Number(event.currentTarget.value),
                  })
                }
                type="number"
                value={text.fontSize}
              />
            </label>
            <label>
              颜色
              <input
                aria-label="标题颜色"
                onBlur={() => endTransaction(`text-${text.id}-color`)}
                onChange={(event) =>
                  updateText("color", { color: event.currentTarget.value })
                }
                type="color"
                value={text.color}
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>变换</legend>
            {(
              [
                ["x", "位置 X", 0, 1, 0.01],
                ["y", "位置 Y", 0, 1, 0.01],
                ["scale", "缩放", 0.1, 4, 0.01],
                ["rotationDeg", "旋转", -180, 180, 1],
              ] as const
            ).map(([field, label, min, max, step]) => (
              <label key={field}>
                {label} {text[field]}
                <input
                  aria-label={label}
                  max={max}
                  min={min}
                  onBlur={() => endTransaction(`text-${text.id}-${field}`)}
                  onChange={(event) =>
                    updateText(field, {
                      [field]: Number(event.currentTarget.value),
                    })
                  }
                  step={step}
                  type="range"
                  value={text[field]}
                />
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>显示时间</legend>
            <label>
              开始（秒）
              <input
                aria-label="标题开始时间"
                min={0}
                onBlur={() => endTransaction(`text-${text.id}-startUs`)}
                onChange={(event) =>
                  updateText("startUs", {
                    startUs: microseconds(event.currentTarget.value),
                  })
                }
                step={0.01}
                type="number"
                value={seconds(text.startUs)}
              />
            </label>
            <label>
              结束（秒）
              <input
                aria-label="标题结束时间"
                min={0.1}
                onBlur={() => endTransaction(`text-${text.id}-endUs`)}
                onChange={(event) =>
                  updateText("endUs", {
                    endUs: microseconds(event.currentTarget.value),
                  })
                }
                step={0.01}
                type="number"
                value={seconds(text.endUs)}
              />
            </label>
          </fieldset>
        </>
      ) : null}
    </aside>
  );
}
