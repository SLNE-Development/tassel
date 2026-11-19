// Rotating and scaling several objects as one unit about a common pivot (object mode, multi-selection).
// The maths is in src/core/transformMath.ts (shared with scene.transform_objects); this adapts it to three.js types.
import type { Quaternion, Vector3 } from 'three';
import * as core from '../core/transformMath';
import type { Transform, Vec3 } from '../core/types';

const toVec3 = (v: Vector3): Vec3 => [v.x, v.y, v.z];

/** The transform after rotating the object by `rotation` (world space) about `pivot`. */
export function rotateAbout(t: Transform, pivot: Vector3, rotation: Quaternion): Transform {
  return core.rotateAbout(t, toVec3(pivot), core.quaternionMatrix(rotation.x, rotation.y, rotation.z, rotation.w));
}

/**
 * The transform after scaling the object by `scale` along the world axes about `pivot`.
 * Exact for a uniform `scale` and for axis-aligned objects, otherwise the closest per-axis scale
 * (see `scaleAbout` in core/transformMath.ts).
 */
export function scaleAbout(t: Transform, pivot: Vector3, scale: Vector3): Transform {
  return core.scaleAbout(t, toVec3(pivot), toVec3(scale));
}
