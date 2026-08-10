import { migrateProjectDocument } from "./migrations";
import type { ProjectDocument } from "./schema";
import { ProjectValidationError, validateProjectDocument } from "./validation";

export class NonJsonValueError extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "NonJsonValueError";
  }
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NonJsonValueError(path, "数字必须是有限值");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new NonJsonValueError(path, `不支持 ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new NonJsonValueError(path, "不允许循环引用");
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonValue(entry, `${path}[${index}]`, ancestors),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NonJsonValueError(path, "只允许普通对象");
    }
    for (const [key, entry] of Object.entries(value)) {
      assertJsonValue(entry, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function assertPureJson(value: unknown): void {
  assertJsonValue(value, "$", new Set());
}

export function cloneProjectDocument(
  project: ProjectDocument,
): ProjectDocument {
  assertPureJson(project);
  return JSON.parse(JSON.stringify(project)) as ProjectDocument;
}

export function serializeProjectDocument(project: ProjectDocument): string {
  assertPureJson(project);
  const validation = validateProjectDocument(project);
  if (!validation.success) {
    throw new ProjectValidationError(validation.issues);
  }
  return JSON.stringify(validation.data);
}

export function deserializeProjectDocument(json: string): ProjectDocument {
  return migrateProjectDocument(JSON.parse(json) as unknown);
}
