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
  // The fields after `offset` are newer; their defaults keep older project files working unchanged.
  array: z.object({
    count: fields.count.default(2),
    offset: fields.offset.default([2, 0, 0]),
    rotation: vec3.default([0, 0, 0]),
    pivot: vec3.default([0, 0, 0]),
    offsetSpace: z.enum(['local', 'world']).default('local'),
  }),
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
  offset: fields.offset
    .optional()
    .describe(
      'array: translation from one copy to the next (default [2, 0, 0]). In the space given by offsetSpace: the object\'s local axes and units by default (the object\'s own rotation and scale apply to it), or world meters. Use [0, 0, 0] for a purely radial array.',
    ),
  rotation: vec3
    .optional()
    .describe(
      'array: Euler XYZ in degrees by which each copy is turned further than the previous one, about pivot, around the object\'s local axes (default [0, 0, 0]). A radial array of n copies around the local Y axis is count n, offset [0, 0, 0], rotation [0, 360 / n, 0]. Positive Y turns counter-clockwise seen from above.',
    ),
  pivot: vec3
    .optional()
    .describe(
      'array: the point the per-copy rotation turns about, in the object\'s local space (default [0, 0, 0] = the object\'s origin). For a radial array either keep the origin as centre and model the mesh away from it, or set the pivot to the centre of the circle.',
    ),
  offsetSpace: z
    .enum(['local', 'world'])
    .optional()
    .describe(
      'array: space of offset. "local" (default): along the object\'s own axes in its local units. "world": in meters along the world axes, regardless of the object\'s rotation and scale, so copy i lands exactly i * offset away in the scene.',
    ),
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
