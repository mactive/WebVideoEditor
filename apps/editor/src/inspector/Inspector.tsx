import type {
  Effect,
  ProjectCommand,
  ProjectDocument,
} from "@web-video-editor/domain";
import { useRef, useState } from "react";

import {
  MIN_CLIP_DURATION_US,
  clampClipMove,
  clampClipSourceEnd,
  clampClipSourceStart,
  clipDurationUs,
  type ClipTrimLimit,
  type ClipTrimResult,
} from "../timeline/timelineMath";

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

function parseMicroseconds(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1_000_000);
}

function trimLimitNotice(limit: ClipTrimLimit): string | undefined {
  switch (limit) {
    case "minimum-duration":
      return `片段已达到最小时长 ${seconds(MIN_CLIP_DURATION_US)} 秒。`;
    case "source-boundary":
      return "输入已受素材边界限制。";
    case "timeline-boundary":
      return "输入已受时间线起点限制。";
    case "track-conflict":
      return "输入已受同轨相邻片段限制，不能产生重叠。";
    case "none":
      return undefined;
  }
}

function clipTrimChanged(
  clip: ProjectDocument["clips"][number],
  trim: ClipTrimResult,
): boolean {
  return (
    clip.timelineStartUs !== trim.timelineStartUs ||
    clip.sourceStartUs !== trim.sourceStartUs ||
    clip.sourceEndUs !== trim.sourceEndUs
  );
}

export function Inspector({
  onExecute,
  project,
  selectedClipId,
  selectedTextId,
}: InspectorProps) {
  const transactions = useRef(new Map<string, string>());
  const [clipTimeNotice, setClipTimeNotice] = useState<string | undefined>();
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
  const executeClipTrim = (
    field: string,
    trim: ClipTrimResult,
    notice?: string,
  ) => {
    if (!clip) {
      return;
    }
    setClipTimeNotice(notice ?? trimLimitNotice(trim.limit));
    if (!clipTrimChanged(clip, trim)) {
      return;
    }
    onExecute(
      {
        clipId: clip.id,
        sourceEndUs: trim.sourceEndUs,
        sourceStartUs: trim.sourceStartUs,
        timelineStartUs: trim.timelineStartUs,
        type: "clip.trim",
      },
      transaction(`clip-${clip.id}-${field}`),
    );
  };
  const updateClipTimelineStart = (value: string) => {
    if (!clip) {
      return;
    }
    const requestedStartUs = parseMicroseconds(value);
    if (requestedStartUs === null) {
      setClipTimeNotice("请输入非负秒数。");
      return;
    }
    const timelineStartUs = clampClipMove(project, clip.id, requestedStartUs);
    setClipTimeNotice(
      timelineStartUs === requestedStartUs
        ? undefined
        : "输入已受同轨相邻片段限制，不能产生重叠。",
    );
    if (timelineStartUs === clip.timelineStartUs) {
      return;
    }
    onExecute(
      {
        clipId: clip.id,
        timelineStartUs,
        type: "clip.move",
      },
      transaction(`clip-${clip.id}-timeline`),
    );
  };
  const updateClipSourceStart = (value: string) => {
    if (!clip) {
      return;
    }
    const sourceStartUs = parseMicroseconds(value);
    if (sourceStartUs === null) {
      setClipTimeNotice("请输入非负秒数。");
      return;
    }
    executeClipTrim(
      "source-start",
      clampClipSourceStart(project, clip, sourceStartUs),
    );
  };
  const updateClipSourceEnd = (value: string) => {
    if (!clip || !asset) {
      setClipTimeNotice("素材信息缺失，无法裁剪。");
      return;
    }
    const sourceEndUs = parseMicroseconds(value);
    if (sourceEndUs === null) {
      setClipTimeNotice("请输入非负秒数。");
      return;
    }
    executeClipTrim(
      "source-end",
      clampClipSourceEnd(project, clip, asset.durationUs, sourceEndUs),
    );
  };
  const updateClipDuration = (value: string) => {
    if (!clip || !asset) {
      setClipTimeNotice("素材信息缺失，无法改长。");
      return;
    }
    const durationUs = parseMicroseconds(value);
    if (durationUs === null || durationUs <= 0) {
      setClipTimeNotice("请输入大于 0 的片段时长。");
      return;
    }
    executeClipTrim(
      "duration",
      clampClipSourceEnd(
        project,
        clip,
        asset.durationUs,
        clip.sourceStartUs + durationUs,
      ),
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
            {clipTimeNotice ? (
              <p className="inspector__notice" role="status">
                {clipTimeNotice}
              </p>
            ) : null}
            <label>
              时间线起点（秒）
              <input
                min={0}
                onBlur={() => endTransaction(`clip-${clip.id}-timeline`)}
                onChange={(event) =>
                  updateClipTimelineStart(event.currentTarget.value)
                }
                step={0.01}
                type="number"
                value={seconds(clip.timelineStartUs)}
              />
            </label>
            <label>
              片段时长（秒）
              <input
                min={seconds(MIN_CLIP_DURATION_US)}
                onBlur={() => endTransaction(`clip-${clip.id}-duration`)}
                onChange={(event) =>
                  updateClipDuration(event.currentTarget.value)
                }
                step={0.01}
                type="number"
                value={seconds(clipDurationUs(clip))}
              />
            </label>
            <label>
              源入点（秒）
              <input
                min={0}
                onBlur={() => endTransaction(`clip-${clip.id}-source-start`)}
                onChange={(event) =>
                  updateClipSourceStart(event.currentTarget.value)
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
                  updateClipSourceEnd(event.currentTarget.value)
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
