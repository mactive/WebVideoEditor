import {
  DEFAULT_TEXT_FONT_FAMILY,
  type Effect,
  type ProjectCommand,
  type ProjectDocument,
} from "@web-video-editor/domain";
import { useMemo, useRef, useState } from "react";

import {
  MIN_CLIP_DURATION_US,
  MIN_TEXT_DURATION_US,
  clampClipMove,
  clampClipSourceEnd,
  clampClipSourceStart,
  clipDurationUs,
  type ClipTrimLimit,
  type ClipTrimResult,
} from "../timeline/timelineMath";

import "./Inspector.css";

type TextUpdatePatch = Extract<
  ProjectCommand,
  { type: "text.update" }
>["patch"];

type LocalFontData = {
  family: string;
};

type FontAccessWindow = Window &
  typeof globalThis & {
    queryLocalFonts?: () => Promise<LocalFontData[]>;
  };

const CUSTOM_FONT_VALUE = "__custom__";
const MAX_TEXT_FONT_SIZE = 300;
const MAX_TEXT_STROKE_WIDTH = 20;
const COMMON_FONT_PRESETS = [
  { label: "Inter", value: DEFAULT_TEXT_FONT_FAMILY },
  {
    label: "系统无衬线",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "等宽字体", value: '"SFMono-Regular", Consolas, monospace' },
] as const;

export type InspectorProps = {
  onExecute(command: ProjectCommand, transactionId?: string): void;
  project: ProjectDocument;
  selectedClipId: string | null;
  selectedTextId: string | null;
};

function seconds(valueUs: number): number {
  return Math.round(valueUs / 1_000) / 1_000;
}

function parseMicroseconds(value: string): number | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return Math.round(seconds * 1_000_000);
}

function parseBoundedNumber(
  value: string,
  min: number,
  max?: number,
): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    return null;
  }
  if (max !== undefined && number > max) {
    return null;
  }
  return number;
}

function isColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function textDurationUs(text: ProjectDocument["texts"][number]): number {
  return text.endUs - text.startUs;
}

function hasTextRangeConflict(
  project: ProjectDocument,
  textId: string,
  trackId: string,
  startUs: number,
  endUs: number,
): boolean {
  return project.texts.some(
    (candidate) =>
      candidate.id !== textId &&
      candidate.trackId === trackId &&
      startUs < candidate.endUs &&
      endUs > candidate.startUs,
  );
}

function canQueryLocalFonts(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as FontAccessWindow).queryLocalFonts === "function"
  );
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
  const [textNotice, setTextNotice] = useState<string | undefined>();
  const [fontNotice, setFontNotice] = useState<string | undefined>();
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
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
  const fontOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const preset of COMMON_FONT_PRESETS) {
      options.set(preset.value, preset.label);
    }
    for (const font of systemFonts) {
      options.set(font, font);
    }
    return [...options.entries()].map(([value, label]) => ({ label, value }));
  }, [systemFonts]);
  const selectedFontOption =
    text && fontOptions.some((option) => option.value === text.fontFamily)
      ? text.fontFamily
      : CUSTOM_FONT_VALUE;

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

  const updateText = (field: string, patch: TextUpdatePatch) => {
    if (!text) {
      return;
    }
    const startUs = patch.startUs ?? text.startUs;
    const endUs = patch.endUs ?? text.endUs;
    if (
      !Number.isInteger(startUs) ||
      !Number.isInteger(endUs) ||
      startUs < 0 ||
      endUs <= 0 ||
      startUs >= endUs
    ) {
      setTextNotice("请输入合法的文字时间范围，开始必须早于结束。");
      return;
    }
    if (endUs - startUs < MIN_TEXT_DURATION_US) {
      setTextNotice(
        `文字时长不能短于 ${seconds(MIN_TEXT_DURATION_US)} 秒。`,
      );
      return;
    }
    if (
      hasTextRangeConflict(
        project,
        text.id,
        patch.trackId ?? text.trackId,
        startUs,
        endUs,
      )
    ) {
      setTextNotice("输入会导致同一文字轨内文字重叠，未写入工程。");
      return;
    }
    if (
      patch.fontSize !== undefined &&
      parseBoundedNumber(String(patch.fontSize), 1, MAX_TEXT_FONT_SIZE) === null
    ) {
      setTextNotice(`文字字号必须在 1 到 ${MAX_TEXT_FONT_SIZE} 之间。`);
      return;
    }
    if (
      patch.strokeWidth !== undefined &&
      parseBoundedNumber(
        String(patch.strokeWidth),
        0,
        MAX_TEXT_STROKE_WIDTH,
      ) === null
    ) {
      setTextNotice(`描边宽度必须在 0 到 ${MAX_TEXT_STROKE_WIDTH} 之间。`);
      return;
    }
    if (
      patch.backgroundOpacity !== undefined &&
      parseBoundedNumber(String(patch.backgroundOpacity), 0, 1) === null
    ) {
      setTextNotice("背景透明度必须在 0 到 1 之间。");
      return;
    }
    if (
      (patch.color !== undefined && !isColor(patch.color)) ||
      (patch.strokeColor !== undefined && !isColor(patch.strokeColor)) ||
      (patch.backgroundColor !== undefined && !isColor(patch.backgroundColor))
    ) {
      setTextNotice("颜色必须是 #RRGGBB 格式。");
      return;
    }
    if (patch.fontFamily !== undefined && patch.fontFamily.trim() === "") {
      setTextNotice("字体名称不能为空。");
      return;
    }
    setTextNotice(undefined);
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
  const updateTextTime = (
    field: "startUs" | "endUs" | "durationUs",
    value: string,
  ) => {
    if (!text) {
      return;
    }
    const valueUs = parseMicroseconds(value);
    if (
      valueUs === null ||
      (field === "durationUs" && valueUs < MIN_TEXT_DURATION_US)
    ) {
      setTextNotice(
        `请输入非负秒数，持续时长不能短于 ${seconds(
          MIN_TEXT_DURATION_US,
        )} 秒。`,
      );
      return;
    }
    if (field === "durationUs") {
      updateText("durationUs", { endUs: text.startUs + valueUs });
      return;
    }
    updateText(field, { [field]: valueUs });
  };
  const updateTextNumber = (
    field: "fontSize" | "strokeWidth" | "backgroundOpacity",
    value: string,
    min: number,
    max?: number,
  ) => {
    const next = parseBoundedNumber(value, min, max);
    if (next === null) {
      setTextNotice(
        max === undefined
          ? "请输入合法数值。"
          : `请输入 ${min} 到 ${max} 之间的数值。`,
      );
      return;
    }
    updateText(field, { [field]: next });
  };
  const loadSystemFonts = async () => {
    if (!canQueryLocalFonts()) {
      setFontNotice("当前浏览器不支持系统字体枚举，可使用预设或手动字体名。");
      return;
    }
    try {
      const fonts = await (window as FontAccessWindow).queryLocalFonts?.();
      const families = Array.from(
        new Set(
          (fonts ?? [])
            .map((font) => font.family.trim())
            .filter((family) => family.length > 0),
        ),
      ).sort((left, right) => left.localeCompare(right));
      setSystemFonts(families);
      setFontNotice(
        families.length > 0
          ? `已加载 ${families.length} 个系统字体。`
          : "未读取到系统字体，可使用预设或手动字体名。",
      );
    } catch {
      setFontNotice("无法读取系统字体，可使用预设或手动字体名。");
    }
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
            <legend>文字内容</legend>
            {textNotice ? (
              <p className="inspector__notice" role="status">
                {textNotice}
              </p>
            ) : null}
            <label>
              文字内容
              <textarea
                aria-label="标题文本"
                onBlur={() => endTransaction(`text-${text.id}-text`)}
                onChange={(event) =>
                  updateText("text", { text: event.currentTarget.value })
                }
                value={text.text}
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>显示时间</legend>
            <label>
              开始时间（秒）
              <input
                aria-label="标题开始时间"
                min={0}
                onBlur={() => endTransaction(`text-${text.id}-startUs`)}
                onChange={(event) =>
                  updateTextTime("startUs", event.currentTarget.value)
                }
                step={0.01}
                type="number"
                value={seconds(text.startUs)}
              />
            </label>
            <label>
              结束时间（秒）
              <input
                aria-label="标题结束时间"
                min={seconds(text.startUs + MIN_TEXT_DURATION_US)}
                onBlur={() => endTransaction(`text-${text.id}-endUs`)}
                onChange={(event) =>
                  updateTextTime("endUs", event.currentTarget.value)
                }
                step={0.01}
                type="number"
                value={seconds(text.endUs)}
              />
            </label>
            <label>
              持续时长（秒）
              <input
                aria-label="标题持续时长"
                min={seconds(MIN_TEXT_DURATION_US)}
                onBlur={() => endTransaction(`text-${text.id}-durationUs`)}
                onChange={(event) =>
                  updateTextTime("durationUs", event.currentTarget.value)
                }
                step={0.01}
                type="number"
                value={seconds(textDurationUs(text))}
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>文字样式</legend>
            <label>
              字号
              <input
                aria-label="标题字号"
                max={MAX_TEXT_FONT_SIZE}
                min={1}
                onBlur={() => endTransaction(`text-${text.id}-fontSize`)}
                onChange={(event) =>
                  updateTextNumber(
                    "fontSize",
                    event.currentTarget.value,
                    1,
                    MAX_TEXT_FONT_SIZE,
                  )
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
            <label>
              描边颜色
              <input
                aria-label="标题描边颜色"
                onBlur={() => endTransaction(`text-${text.id}-strokeColor`)}
                onChange={(event) =>
                  updateText("strokeColor", {
                    strokeColor: event.currentTarget.value,
                  })
                }
                type="color"
                value={text.strokeColor}
              />
            </label>
            <label>
              描边宽度 {text.strokeWidth}
              <input
                aria-label="标题描边宽度"
                max={MAX_TEXT_STROKE_WIDTH}
                min={0}
                onBlur={() => endTransaction(`text-${text.id}-strokeWidth`)}
                onChange={(event) =>
                  updateTextNumber(
                    "strokeWidth",
                    event.currentTarget.value,
                    0,
                    MAX_TEXT_STROKE_WIDTH,
                  )
                }
                step={0.5}
                type="number"
                value={text.strokeWidth}
              />
            </label>
            <label>
              背景底色
              <input
                aria-label="标题背景底色"
                onBlur={() => endTransaction(`text-${text.id}-backgroundColor`)}
                onChange={(event) =>
                  updateText("backgroundColor", {
                    backgroundColor: event.currentTarget.value,
                  })
                }
                type="color"
                value={text.backgroundColor}
              />
            </label>
            <label>
              背景透明度 {text.backgroundOpacity.toFixed(2)}
              <input
                aria-label="标题背景透明度"
                max={1}
                min={0}
                onBlur={() =>
                  endTransaction(`text-${text.id}-backgroundOpacity`)
                }
                onChange={(event) =>
                  updateTextNumber(
                    "backgroundOpacity",
                    event.currentTarget.value,
                    0,
                    1,
                  )
                }
                step={0.01}
                type="number"
                value={text.backgroundOpacity}
              />
            </label>
          </fieldset>
          <fieldset>
            <legend>字体</legend>
            {fontNotice ? (
              <p className="inspector__notice" role="status">
                {fontNotice}
              </p>
            ) : null}
            <label>
              字体预设
              <select
                aria-label="标题字体预设"
                onBlur={() => endTransaction(`text-${text.id}-fontFamily`)}
                onChange={(event) => {
                  const fontFamily = event.currentTarget.value;
                  if (fontFamily !== CUSTOM_FONT_VALUE) {
                    updateText("fontFamily", { fontFamily });
                  }
                }}
                value={selectedFontOption}
              >
                {selectedFontOption === CUSTOM_FONT_VALUE ? (
                  <option value={CUSTOM_FONT_VALUE}>自定义字体</option>
                ) : null}
                {fontOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="inspector__font-actions">
              <button
                disabled={!canQueryLocalFonts()}
                onClick={() => {
                  void loadSystemFonts();
                }}
                type="button"
              >
                加载系统字体
              </button>
              {!canQueryLocalFonts() ? (
                <span>不可用时使用预设或手动字体名。</span>
              ) : null}
            </div>
            <label>
              手动字体名
              <input
                aria-label="标题字体名称"
                onBlur={() => endTransaction(`text-${text.id}-fontFamily`)}
                onChange={(event) =>
                  updateText("fontFamily", {
                    fontFamily: event.currentTarget.value.trim(),
                  })
                }
                type="text"
                value={text.fontFamily}
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
        </>
      ) : null}
    </aside>
  );
}
