import {
  LOG_LEVELS,
  MARKER_EVENTS,
  isLogLevel,
  isLogMarker,
  isMarkerEvent,
} from "./dictionary";
import type { LogEntry, LogValue, SerializedLogError } from "./types";

const entryKeys = new Set([
  "durationMs",
  "error",
  "event",
  "input",
  "level",
  "marker",
  "output",
  "projectRevision",
  "requestId",
  "scope",
  "timestamp",
]);
const errorKeys = new Set(["cause", "context", "message", "name", "stack"]);
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export class LogSchemaError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid log entry: ${issues.join("; ")}`);
    this.name = "LogSchemaError";
    this.issues = issues;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateLogValue(
  value: unknown,
  path: string,
  issues: string[],
  seen: WeakSet<object>,
): value is LogValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push(`${path} must contain only finite numbers`);
      return false;
    }
    return true;
  }
  if (typeof value !== "object") {
    issues.push(`${path} must be JSON-compatible`);
    return false;
  }
  if (seen.has(value)) {
    issues.push(`${path} must not contain circular references`);
    return false;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const valid = value.every((item, index) =>
      validateLogValue(item, `${path}[${index}]`, issues, seen),
    );
    seen.delete(value);
    return valid;
  }
  if (!isPlainObject(value)) {
    issues.push(`${path} must not contain raw binary or runtime objects`);
    seen.delete(value);
    return false;
  }
  const valid = Object.entries(value).every(([key, item]) =>
    validateLogValue(item, `${path}.${key}`, issues, seen),
  );
  seen.delete(value);
  return valid;
}

function validateSerializedError(
  value: unknown,
  path: string,
  issues: string[],
): value is SerializedLogError {
  if (!isPlainObject(value)) {
    issues.push(`${path} must be a serialized error object`);
    return false;
  }
  for (const key of unknownKeys(value, errorKeys)) {
    issues.push(`${path} contains unknown field "${key}"`);
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    issues.push(`${path}.name must be a non-empty string`);
  }
  if (typeof value.message !== "string") {
    issues.push(`${path}.message must be a string`);
  }
  if (value.stack !== undefined && typeof value.stack !== "string") {
    issues.push(`${path}.stack must be a string`);
  }
  if (value.context !== undefined) {
    validateLogValue(value.context, `${path}.context`, issues, new WeakSet());
  }
  if (value.cause !== undefined) {
    if (
      isPlainObject(value.cause) &&
      typeof value.cause.name === "string" &&
      typeof value.cause.message === "string"
    ) {
      validateSerializedError(value.cause, `${path}.cause`, issues);
    } else {
      validateLogValue(value.cause, `${path}.cause`, issues, new WeakSet());
    }
  }
  return issues.length === 0;
}

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function validateLogEntry(value: unknown): readonly string[] {
  const issues: string[] = [];
  if (!isPlainObject(value)) {
    return ["entry must be an object"];
  }

  for (const key of unknownKeys(value, entryKeys)) {
    issues.push(`entry contains unknown field "${key}"`);
  }
  if (!isStrictTimestamp(value.timestamp)) {
    issues.push("timestamp must be an ISO 8601 UTC string with milliseconds");
  }
  if (!isLogLevel(value.level)) {
    issues.push(`level must be one of: ${LOG_LEVELS.join(", ")}`);
  }
  if (!isLogMarker(value.marker)) {
    issues.push("marker is not registered");
  } else if (!isMarkerEvent(value.marker, value.event)) {
    issues.push(`event is not registered for marker ${value.marker}`);
  }
  if (typeof value.scope !== "string" || !scopePattern.test(value.scope)) {
    issues.push("scope must be a non-empty stable identifier");
  }
  if (
    value.requestId !== undefined &&
    (typeof value.requestId !== "string" ||
      !requestIdPattern.test(value.requestId))
  ) {
    issues.push("requestId must be a non-empty stable identifier");
  }
  if (
    value.projectRevision !== undefined &&
    (typeof value.projectRevision !== "number" ||
      !Number.isSafeInteger(value.projectRevision) ||
      value.projectRevision < 0)
  ) {
    issues.push("projectRevision must be a non-negative safe integer");
  }
  if (
    value.durationMs !== undefined &&
    (typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0)
  ) {
    issues.push("durationMs must be a non-negative finite number");
  }
  if (value.input !== undefined) {
    validateLogValue(value.input, "input", issues, new WeakSet());
  }
  if (value.output !== undefined) {
    validateLogValue(value.output, "output", issues, new WeakSet());
  }
  if (value.error !== undefined) {
    validateSerializedError(value.error, "error", issues);
  }
  return issues;
}

export function isLogEntry(value: unknown): value is LogEntry {
  return validateLogEntry(value).length === 0;
}

export function parseLogEntry(value: unknown): LogEntry {
  const issues = validateLogEntry(value);
  if (issues.length > 0) {
    throw new LogSchemaError(issues);
  }
  return value as LogEntry;
}

const markerEventSchemas = Object.entries(MARKER_EVENTS).map(
  ([marker, events]) => ({
    properties: {
      event: { enum: events },
      marker: { const: marker },
    },
    required: ["marker", "event"],
  }),
);

export const LOG_ENTRY_JSON_SCHEMA = {
  $id: "https://web-video-editor.local/schemas/log-entry.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  oneOf: markerEventSchemas,
  properties: {
    durationMs: { minimum: 0, type: "number" },
    error: {
      additionalProperties: false,
      properties: {
        cause: {},
        context: {},
        message: { type: "string" },
        name: { minLength: 1, type: "string" },
        stack: { type: "string" },
      },
      required: ["name", "message"],
      type: "object",
    },
    event: { type: "string" },
    input: {},
    level: { enum: LOG_LEVELS },
    marker: { enum: Object.keys(MARKER_EVENTS) },
    output: {},
    projectRevision: { minimum: 0, type: "integer" },
    requestId: {
      maxLength: 128,
      pattern: requestIdPattern.source,
      type: "string",
    },
    scope: {
      maxLength: 128,
      pattern: scopePattern.source,
      type: "string",
    },
    timestamp: {
      format: "date-time",
      type: "string",
    },
  },
  required: ["timestamp", "level", "marker", "scope", "event"],
  title: "Web Video Editor Structured Log Entry",
  type: "object",
} as const;
