import { z } from 'zod';
import { booleanOperations } from '../types';

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

/** Parameters of each modifier type (without id / enabled). Defaults are what a new modifier starts with. */
export const modifierParams = {
  mirror: z.object({
    axes: z.object({ x: z.boolean(), y: z.boolean(), z: z.boolean() }).default({ x: true, y: false, z: false }),
    mergeDistance: z.number().min(0).default(0.001),
  }),
  subdivision: z.object({ levels: z.number().int().min(1).max(4).default(1) }),
  array: z.object({ count: z.number().int().min(1).max(1000).default(2), offset: vec3.default([2, 0, 0]) }),
  boolean: z.object({
    operation: z.enum(booleanOperations).default('difference'),
    targetId: z.string().nullable().default(null),
  }),
};

const base = { id: z.string().min(1), enabled: z.boolean().default(true) };

/** Validates modifiers from untrusted input (project files). */
export const modifierSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('mirror'), ...modifierParams.mirror.shape }),
  z.object({ ...base, type: z.literal('subdivision'), ...modifierParams.subdivision.shape }),
  z.object({ ...base, type: z.literal('array'), ...modifierParams.array.shape }),
  z.object({ ...base, type: z.literal('boolean'), ...modifierParams.boolean.shape }),
]);
