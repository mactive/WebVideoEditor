import { type ProjectDocument, projectDocumentSchema } from "./schema";

export type ProjectValidationIssue = {
  code:
    | "duplicate_id"
    | "invalid_boundary"
    | "invalid_reference"
    | "overlap"
    | "schema";
  message: string;
  path: string;
};

export type ProjectValidationResult =
  | { success: true; data: ProjectDocument; issues: [] }
  | { success: false; issues: ProjectValidationIssue[] };

export class ProjectValidationError extends Error {
  readonly issues: ProjectValidationIssue[];

  constructor(issues: ProjectValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

function duplicateIssues(
  values: ReadonlyArray<{ id: string }>,
  path: string,
): ProjectValidationIssue[] {
  const seen = new Set<string>();
  const issues: ProjectValidationIssue[] = [];

  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      issues.push({
        code: "duplicate_id",
        path: `${path}.${index}.id`,
        message: `ID "${value.id}" 重复`,
      });
    }
    seen.add(value.id);
  }

  return issues;
}

export function validateProjectInvariants(
  project: ProjectDocument,
): ProjectValidationIssue[] {
  const issues = [
    ...duplicateIssues(project.assets, "assets"),
    ...duplicateIssues(project.tracks, "tracks"),
    ...duplicateIssues(project.clips, "clips"),
    ...duplicateIssues(project.texts, "texts"),
  ];
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const tracks = new Map(project.tracks.map((track) => [track.id, track]));

  for (const [index, clip] of project.clips.entries()) {
    const path = `clips.${index}`;
    const asset = assets.get(clip.assetId);
    const track = tracks.get(clip.trackId);

    if (!asset) {
      issues.push({
        code: "invalid_reference",
        path: `${path}.assetId`,
        message: `素材 "${clip.assetId}" 不存在`,
      });
    }
    if (!track || track.kind === "text") {
      issues.push({
        code: "invalid_reference",
        path: `${path}.trackId`,
        message: `轨道 "${clip.trackId}" 不存在或不是媒体轨`,
      });
    }
    if (track?.kind === "audio" && asset && !asset.hasAudio) {
      issues.push({
        code: "invalid_reference",
        path: `${path}.assetId`,
        message: "音频轨片段必须引用包含音频的素材",
      });
    }
    if (clip.sourceStartUs >= clip.sourceEndUs) {
      issues.push({
        code: "invalid_boundary",
        path,
        message: "sourceStartUs 必须小于 sourceEndUs",
      });
    }
    if (asset && clip.sourceEndUs > asset.durationUs) {
      issues.push({
        code: "invalid_boundary",
        path: `${path}.sourceEndUs`,
        message: "片段源结束时间超出素材时长",
      });
    }
  }

  for (const [index, text] of project.texts.entries()) {
    const track = tracks.get(text.trackId);
    if (!track || track.kind !== "text") {
      issues.push({
        code: "invalid_reference",
        path: `texts.${index}.trackId`,
        message: `轨道 "${text.trackId}" 不存在或不是文字轨`,
      });
    }
    if (text.startUs >= text.endUs) {
      issues.push({
        code: "invalid_boundary",
        path: `texts.${index}`,
        message: "文字开始时间必须小于结束时间",
      });
    }
  }

  const clipsByTrack = new Map<string, typeof project.clips>();
  for (const clip of project.clips) {
    const track = tracks.get(clip.trackId);
    if (!track || track.kind === "text") {
      continue;
    }
    const clips = clipsByTrack.get(clip.trackId) ?? [];
    clips.push(clip);
    clipsByTrack.set(clip.trackId, clips);
  }
  for (const clips of clipsByTrack.values()) {
    const sorted = [...clips].sort(
      (left, right) => left.timelineStartUs - right.timelineStartUs,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (
        previous &&
        current &&
        previous.timelineStartUs +
          (previous.sourceEndUs - previous.sourceStartUs) >
          current.timelineStartUs
      ) {
        issues.push({
          code: "overlap",
          path: `clips.${current.id}`,
          message: `片段 "${previous.id}" 与 "${current.id}" 重叠`,
        });
      }
    }
  }

  return issues;
}

export function validateProjectDocument(
  input: unknown,
): ProjectValidationResult {
  const parsed = projectDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema",
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  const issues = validateProjectInvariants(parsed.data);
  return issues.length === 0
    ? { success: true, data: parsed.data, issues: [] }
    : { success: false, issues };
}

export function assertValidProjectDocument(
  input: unknown,
): asserts input is ProjectDocument {
  const result = validateProjectDocument(input);
  if (!result.success) {
    throw new ProjectValidationError(result.issues);
  }
}
