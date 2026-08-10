import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1 as const;

const idSchema = z.string().trim().min(1);
const timestampSchema = z.string().datetime({ offset: true });
const microsecondsSchema = z.number().int().nonnegative();

const assetTrackSchema = z
  .object({
    trackId: z.number().int().nonnegative(),
    codec: z.string().trim().min(1),
    codecParameterString: z.string().trim().min(1).nullable(),
    profile: z.string().trim().min(1).nullable(),
  })
  .strict();

export const assetSchema = z
  .object({
    id: idSchema,
    name: z.string().trim().min(1),
    fingerprint: z.string().trim().min(1),
    durationUs: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: z.number().positive(),
    hasAudio: z.boolean(),
    media: z
      .object({
        container: z.string().trim().min(1),
        mimeType: z.string().trim().min(1),
        rotation: z.number().finite(),
        firstKeyframeUs: microsecondsSchema.nullable(),
        video: assetTrackSchema,
        audio: assetTrackSchema
          .extend({
            sampleRate: z.number().int().positive(),
            channels: z.number().int().positive(),
          })
          .strict()
          .nullable(),
        excludedVideoTracks: z.array(
          z
            .object({
              id: z.string().trim().min(1),
              codec: z.string().trim().min(1),
              reason: z.string().trim().min(1),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    source: z
      .object({
        kind: z.enum(["blob", "file", "test-asset", "url"]),
        name: z.string().trim().min(1),
        size: z.number().int().nonnegative(),
        lastModified: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();

export const trackSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["video", "audio", "text"]),
    name: z.string().trim().min(1),
    order: z.number().int().nonnegative(),
    muted: z.boolean(),
    locked: z.boolean(),
  })
  .strict();

const effectBaseSchema = z.object({
  id: idSchema,
  enabled: z.boolean(),
});

export const effectSchema = z.discriminatedUnion("kind", [
  effectBaseSchema
    .extend({
      kind: z.literal("grayscale"),
      amount: z.number().min(0).max(1),
    })
    .strict(),
  effectBaseSchema
    .extend({
      kind: z.literal("vintage"),
      amount: z.number().min(0).max(1),
    })
    .strict(),
  effectBaseSchema
    .extend({
      kind: z.literal("adjustments"),
      brightness: z.number().min(-1).max(1),
      contrast: z.number().min(-1).max(1),
    })
    .strict(),
]);

export const clipTransformSchema = z
  .object({
    rotationDeg: z.number().finite(),
    scale: z.number().positive(),
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const clipSchema = z
  .object({
    id: idSchema,
    assetId: idSchema,
    trackId: idSchema,
    timelineStartUs: microsecondsSchema,
    sourceStartUs: microsecondsSchema,
    sourceEndUs: z.number().int().positive(),
    effects: z.array(effectSchema),
    transform: clipTransformSchema.optional(),
  })
  .strict();

export const textSchema = z
  .object({
    id: idSchema,
    trackId: idSchema,
    text: z.string(),
    startUs: microsecondsSchema,
    endUs: z.number().int().positive(),
    fontSize: z.number().positive(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    x: z.number(),
    y: z.number(),
    scale: z.number().positive(),
    rotationDeg: z.number(),
  })
  .strict();

export const canvasSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();

export const exportSettingsSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: z.number().positive(),
    videoCodec: z.literal("h264"),
    audioCodec: z.literal("aac"),
    videoBitrate: z.number().int().positive(),
    audioBitrate: z.number().int().positive(),
  })
  .strict();

export const projectDocumentSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: idSchema,
    name: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    assets: z.array(assetSchema),
    tracks: z.array(trackSchema),
    clips: z.array(clipSchema),
    texts: z.array(textSchema),
    canvas: canvasSchema,
    exportSettings: exportSettingsSchema,
  })
  .strict();

export type Asset = z.infer<typeof assetSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type ClipTransform = z.infer<typeof clipTransformSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type Text = z.infer<typeof textSchema>;
export type TextItem = Text;
export type Canvas = z.infer<typeof canvasSchema>;
export type ExportSettings = z.infer<typeof exportSettingsSchema>;
export type ProjectDocument = z.infer<typeof projectDocumentSchema>;
