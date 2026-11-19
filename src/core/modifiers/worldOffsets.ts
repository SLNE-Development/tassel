// World-space array offsets travel rigidly with their object.
//
// An array modifier with `offsetSpace: 'world'` stores its offset along the world axes in meters. That is
// what it means at the moment it is set; from then on the row of copies belongs to the object and turns
// and scales with it. So every command that gives an object another rotation or scale re-expresses the
// offset for the new transform (`withTransform` / `carryWorldOffsets`): the offset in the object's LOCAL
// space - which is what the evaluated mesh is built from - stays what it was, and with it the evaluated
// local mesh. The object in the world after the change is therefore exactly the object before it, taken
// through the same change as the object itself. Translation never matters, and the per-copy `rotation` /
// `pivot` of an array are local anyway.
import { apply3, eulerMatrix, type Mat3 } from '../transformMath';
import type { Modifier, SceneObject, Transform, Vec3 } from '../types';
import { worldToLocalOffset } from './array';

/**
 * Offsets are stored rounded to 1e-12 m, so that a 90° turn gives 0 and not 6e-17. Not coarser: on a small
 * object the rounding is magnified by 1 / scale in local space and comes back when the object is scaled up.
 */
const tidy = (v: number) => Math.round(v * 1e12) / 1e12 + 0;

const isWorldArray = (m: Modifier) => m.type === 'array' && m.offsetSpace === 'world';

const sameOrientation = (a: Transform, b: Transform) =>
  a === b || [0, 1, 2].every((i) => a.rotation[i] === b.rotation[i] && a.scale[i] === b.scale[i]);

/**
 * The modifiers with `map` applied to the offset of every world-space array (disabled ones too: they
 * belong to the object just the same). Without such a modifier the same array is returned.
 */
export function mapWorldOffsets(modifiers: readonly Modifier[], map: (offset: Vec3) => Vec3): readonly Modifier[] {
  if (!modifiers.some(isWorldArray)) return modifiers;
  return modifiers.map((m): Modifier => (m.type === 'array' && m.offsetSpace === 'world' ? { ...m, offset: map(m.offset).map(tidy) as Vec3 } : m));
}

/**
 * The modifiers of an object whose transform changes from `from` to `to`: world-space array offsets are
 * taken along (new offset = R1 * S1 * S0^-1 * R0^T * offset), so that the offset in local space, and with it
 * the evaluated local mesh, stays the same. Returns the same array if nothing has to change (no world-space
 * array, or rotation and scale are unchanged). A scale of zero in either transform has no inverse (such an
 * array cannot be evaluated at all); the offsets are then left as they are.
 */
export function carryWorldOffsets(modifiers: readonly Modifier[], from: Transform, to: Transform): readonly Modifier[] {
  if (sameOrientation(from, to) || !modifiers.some(isWorldArray)) return modifiers;
  if (from.scale.some((s) => Math.abs(s) < 1e-12) || to.scale.some((s) => Math.abs(s) < 1e-12)) return modifiers;
  const r0 = eulerMatrix(from.rotation);
  const r1 = eulerMatrix(to.rotation);
  return mapWorldOffsets(modifiers, (w) =>
    apply3(
      r1,
      // R0^T * w is the offset along the object's own axes; each axis is then stretched as the object is.
      [0, 1, 2].map((c) => ((r0[c] * w[0] + r0[3 + c] * w[1] + r0[6 + c] * w[2]) * to.scale[c]) / from.scale[c]),
    ),
  );
}

/**
 * The object with another transform, as every command must set it: its world-space array offsets move
 * rigidly with it (see `carryWorldOffsets`). Not for changes that also rewrite the mesh (bake, mirror).
 */
export function withTransform(obj: SceneObject, transform: Transform): SceneObject {
  if (transform === obj.transform) return obj;
  return { ...obj, transform, modifiers: carryWorldOffsets(obj.modifiers, obj.transform, transform) };
}

/** World-space array offsets after the linear part of an affine 3x4 matrix was baked into the mesh of an object that is left without rotation and scale. */
export function bakeWorldOffsets(modifiers: readonly Modifier[], m: readonly number[]): readonly Modifier[] {
  const linear: Mat3 = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  return mapWorldOffsets(modifiers, (w) => apply3(linear, w));
}

// Per modifier list (immutable): its local form for one static transform. During playback the same list
// is asked for on every frame, and the stable result keeps evaluateObject's cache valid.
const localized = new WeakMap<readonly Modifier[], { transform: Transform; modifiers: readonly Modifier[] }>();

/**
 * The modifiers with every world-space array offset replaced by the equal local offset for an object with
 * the transform `rest`. Used for poses that differ from the stored (static) transform, i.e. animation:
 * evaluated like this, the object's copies move rigidly with whatever transform it is shown at. Cached per
 * modifier list. Returns the same array if there is nothing to convert or `rest` has a scale of zero.
 */
export function localizeWorldOffsets(modifiers: readonly Modifier[], rest: Transform): readonly Modifier[] {
  if (!modifiers.some(isWorldArray)) return modifiers;
  const hit = localized.get(modifiers);
  if (hit && sameOrientation(hit.transform, rest)) return hit.modifiers;
  let result = modifiers;
  if (!rest.scale.some((s) => Math.abs(s) < 1e-12)) {
    result = modifiers.map((m): Modifier => (m.type === 'array' && m.offsetSpace === 'world' ? { ...m, offsetSpace: 'local', offset: worldToLocalOffset(m.offset, rest) } : m));
  }
  localized.set(modifiers, { transform: rest, modifiers: result });
  return result;
}
