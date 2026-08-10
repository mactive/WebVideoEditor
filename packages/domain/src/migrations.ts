import { z } from "zod";

import {
  PROJECT_SCHEMA_VERSION,
  type ProjectDocument,
  projectDocumentSchema,
} from "./schema";
import { ProjectValidationError, validateProjectDocument } from "./validation";

const projectDocumentV0Schema = projectDocumentSchema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(0),
    canvas: projectDocumentSchema.shape.canvas.omit({
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
