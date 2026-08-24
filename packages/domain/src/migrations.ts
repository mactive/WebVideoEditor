import { z } from "zod";

import {
  DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
  projectDocumentSchema,
} from "./schema";
import { projectContentEndUs } from "./project";
import { ProjectValidationError, validateProjectDocument } from "./validation";

const projectDocumentV1Schema = projectDocumentSchema
  .omit({ schemaVersion: true, timeline: true })
  .extend({
    schemaVersion: z.literal(1),
  })
  .strict();

const projectDocumentV0Schema = projectDocumentV1Schema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(0),
    canvas: projectDocumentV1Schema.shape.canvas.omit({
      backgroundColor: true,
    }),
  })
  .strict();

type Migration = (input: unknown) => unknown;

const migrations: Record<number, Migration> = {
  0: (input) => {
    const project = projectDocumentV0Schema.parse(input);
    return {
      ...project,
      schemaVersion: 1,
      canvas: {
        ...project.canvas,
        backgroundColor: "#000000",
      },
    };
  },
  1: (input) => {
    const project = projectDocumentV1Schema.parse(input);
    const tracks = [...project.tracks]
      .sort(
        (left, right) =>
          left.order - right.order || left.id.localeCompare(right.id),
      )
      .map((track, index) => ({ ...track, order: index }));
    return {
      ...project,
      schemaVersion: 2,
      tracks,
      timeline: {
        durationUs: projectContentEndUs(project),
        defaultScale: {
          pixelsPerSecond: DEFAULT_TIMELINE_SCALE_PIXELS_PER_SECOND,
        },
      },
    };
  },
};

function schemaVersionOf(input: unknown): number {
  if (
    typeof input !== "object" ||
    input === null ||
    !("schemaVersion" in input) ||
    typeof input.schemaVersion !== "number" ||
    !Number.isInteger(input.schemaVersion)
  ) {
    throw new Error("Project Document 缺少有效的 schemaVersion");
  }
  return input.schemaVersion;
}

export function migrateProjectDocument(input: unknown): ProjectDocument {
  let current = input;
  let version = schemaVersionOf(current);

  if (version > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `不支持 schemaVersion ${version}，当前最高版本为 ${PROJECT_SCHEMA_VERSION}`,
    );
  }

  while (version < PROJECT_SCHEMA_VERSION) {
    const migration = migrations[version];
    if (!migration) {
      throw new Error(`缺少 schemaVersion ${version} 的迁移函数`);
    }
    current = migration(current);
    version = schemaVersionOf(current);
  }

  const result = validateProjectDocument(current);
  if (!result.success) {
    throw new ProjectValidationError(result.issues);
  }
  return result.data;
}
