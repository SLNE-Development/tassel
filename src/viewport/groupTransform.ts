// Rotating and scaling several objects as one unit about a common pivot (object mode, multi-selection).
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Transform, Vec3 } from '../core/types';

// `+ 0` turns -0 into 0.
const round = (n: number) => Math.round(n * 1e6) / 1e6 + 0;
const toVec3 = (v: { x: number; y: number; z: number }): Vec3 => [round(v.x), round(v.y), round(v.z)];
const rad = MathUtils.degToRad;
const deg = MathUtils.radToDeg;

const quaternionOf = (t: Transform) => new Quaternion().setFromEuler(new Euler(rad(t.rotation[0]), rad(t.rotation[1]), rad(t.rotation[2]), 'XYZ'));

function eulerDegrees(q: Quaternion): Vec3 {
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  // Whole degrees must not come out as 89.999999 (asin is ill-conditioned near ±90°).
  return toVec3({ x: deg(e.x), y: deg(e.y), z: deg(e.z) }).map((a) => (Math.abs(a - Math.round(a)) < 2e-6 ? Math.round(a) + 0 : a)) as Vec3;
}

/** The transform after rotating the object by `rotation` (world space) about `pivot`. */
export function rotateAbout(t: Transform, pivot: Vector3, rotation: Quaternion): Transform {
  const position = new Vector3(...t.position).sub(pivot).applyQuaternion(rotation).add(pivot);
  return { position: toVec3(position), rotation: eulerDegrees(rotation.clone().multiply(quaternionOf(t))), scale: t.scale };
}

/**
 * The transform after scaling the object by `scale` along the world axes about `pivot`.
 *
 * The position is exact. The object's own scale is exact for a uniform `scale` and for objects whose
 * axes line up with the world axes; otherwise the true result would be sheared, which position /
 * rotation / scale cannot express, so each local axis is scaled by how much `scale` stretches a
 * unit vector along it (the closest per-axis scale) and the rotation stays as it is.
 */
export function scaleAbout(t: Transform, pivot: Vector3, scale: Vector3): Transform {
  const position = new Vector3(...t.position).sub(pivot).multiply(scale).add(pivot);
  const basis = new Matrix4().makeRotationFromQuaternion(quaternionOf(t));
  const axis = new Vector3();
  const own = t.scale.map((s, i) => {
    axis.setFromMatrixColumn(basis, i);
    const stretched = axis.clone().multiply(scale);
    // Mirrored if the stretched axis points away from where it pointed.
    return s * stretched.length() * (stretched.dot(axis) < 0 ? -1 : 1);
  });
  return { position: toVec3(position), rotation: t.rotation, scale: toVec3({ x: own[0], y: own[1], z: own[2] }) };
}
