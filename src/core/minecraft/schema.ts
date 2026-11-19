// Zod schemas for the Minecraft parts of a document, shared by the project file and the commands.
import { z } from 'zod';
import { cuboidFaces, guiLights, uvRotations } from '../types';
import type { Cuboid, JavaModelSettings } from '../types';
import { DEFAULT_VERSION } from './versions';

const finite = z.number().finite();
export const pxVec3 = z.tuple([finite, finite, finite]);
export const uvRect = z.tuple([finite, finite, finite, finite]);
export const direction = z.enum(cuboidFaces);
export const uvRotation = z.union(uvRotations.map((r) => z.literal(r)) as unknown as [z.ZodLiteral<0>, z.ZodLiteral<90>, z.ZodLiteral<180>, z.ZodLiteral<270>]);

export const cuboidFaceSchema = z.object({
  enabled: z.boolean().default(true),
  texture: z.string().nullable().default(null),
  uv: uvRect,
  rotation: uvRotation.default(0),
  tintIndex: z.number().int().min(0).nullable().default(null),
  cullface: direction.nullable().default(null),
});

export const cuboidSchema = z.object({
  from: pxVec3,
  to: pxVec3,
  inflate: finite.default(0),
  rescale: z.boolean().default(false),
  shade: z.boolean().default(true),
  lightEmission: z.number().int().min(0).max(15).default(0),
  shadeDirectionOverride: direction.nullable().default(null),
  locked: z.boolean().default(false),
  export: z.boolean().default(true),
  color: z.number().int().min(0).max(7).default(0),
  faces: z.object(Object.fromEntries(cuboidFaces.map((f) => [f, cuboidFaceSchema])) as Record<(typeof cuboidFaces)[number], typeof cuboidFaceSchema>),
}) satisfies z.ZodType<Cuboid, unknown>;

export const textureSizeSchema = z.tuple([z.number().int().min(1).max(4096), z.number().int().min(1).max(4096)]);

export const javaSettingsSchema = z.object({
  version: z.string().min(1).default(DEFAULT_VERSION),
  fileName: z.string().default('model'),
  parent: z.string().default(''),
  ambientOcclusion: z.boolean().default(true),
  guiLight: z.enum(guiLights).nullable().default(null),
  textureSize: textureSizeSchema.default([16, 16]),
  credit: z.string().default(''),
  particle: z.string().nullable().default(null),
  display: z.record(z.string(), z.unknown()).optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<JavaModelSettings, unknown>;

export const javaTextureRefSchema = z.object({
  namespace: z.string().default('minecraft'),
  folder: z.string().default('block'),
  key: z.string().min(1),
});

/** Default settings of a new Minecraft Java document. */
export function defaultJavaSettings(overrides: Partial<JavaModelSettings> = {}): JavaModelSettings {
  return { ...javaSettingsSchema.parse({}), ...overrides };
}
