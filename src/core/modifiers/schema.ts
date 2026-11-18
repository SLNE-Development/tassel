import { z } from 'zod';
import { booleanOperations } from '../types';

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

const fields = {
  axes: z.object({ x: z.boolean(), y: z.boolean(), z: z.boolean() }),
  mergeDistance: z.number().min(0),
  levels: z.number().int().min(1).max(4),
  count: z.number().int().min(1).max(1000),
  offset: vec3,
  operation: z.enum(booleanOperations),
  targetId: z.string().nullable(),
};

/** Parameters of each modifier type (without id / enabled). Defaults are what a new modifier starts with. */
export const modifierParams = {
  mirror: z.object({
    axes: fields.axes.default({ x: true, y: false, z: false }),
    mergeDistance: fields.mergeDistance.default(0.001),
  }),
  subdivision: z.object({ levels: fields.levels.default(1) }),
  array: z.object({ count: fields.count.default(2), offset: fields.offset.default([2, 0, 0]) }),
  boolean: z.object({
    operation: fields.operation.default('difference'),
    targetId: fields.targetId.default(null),
  }),
};

/** All type parameters flat and optional, as the modifier commands take them. `axes` may be partial. */
export const modifierCommandParams = {
  axes: z
    .object({ x: z.boolean().optional(), y: z.boolean().optional(), z: z.boolean().optional() })
    .optional()
    .describe('mirror: mirror across the local planes x=0 / y=0 / z=0. Omitted axes keep their value (default: x only).'),
  mergeDistance: fields.mergeDistance
    .optional()
    .describe('mirror: vertices closer than this to the mirror plane are snapped onto it and welded (default 0.001).'),
  levels: fields.levels.optional().describe('subdivision: Catmull-Clark levels, 1-4 (default 1).'),
  count: fields.count.optional().describe('array: total number of copies including the original (default 2).'),
  offset: fields.offset.optional().describe('array: offset from one copy to the next in local units (default [2, 0, 0]).'),
  operation: fields.operation.optional().describe('boolean: union, difference (this minus target) or intersect (default difference).'),
  targetId: fields.targetId.optional().describe('boolean: id of the other object. Its mesh after its own modifiers is used.'),
};

const base = { id: z.string().min(1), enabled: z.boolean().default(true) };

/** Validates modifiers from untrusted input (project files). */
export const modifierSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('mirror'), ...modifierParams.mirror.shape }),
  z.object({ ...base, type: z.literal('subdivision'), ...modifierParams.subdivision.shape }),
  z.object({ ...base, type: z.literal('array'), ...modifierParams.array.shape }),
  z.object({ ...base, type: z.literal('boolean'), ...modifierParams.boolean.shape }),
]);
