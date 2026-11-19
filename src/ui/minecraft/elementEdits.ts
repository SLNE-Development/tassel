import { modelBox } from '../../core/minecraft/cuboid';
import type { Cuboid, SceneObject, Vec3 } from '../../core/types';

type CuboidObject = SceneObject & { cuboid: Cuboid };

const withAxis = (v: Vec3, i: number, value: number): Vec3 => {
  const next = [...v] as Vec3;
  next[i] = value;
  return next;
};

/** Params of the command that gives an element's box, pivot or rotation one new value on one axis. */
export type BoxField = 'position' | 'size' | 'pivot' | 'rotation';

export function boxParams(obj: CuboidObject, field: BoxField, axis: number, value: number): { command: string; params: Record<string, unknown> } {
  const { from, to, origin } = modelBox(obj);
  const ids = [obj.id];
  switch (field) {
    case 'position': {
      // The box moves, and its pivot with it.
      const shift = value - from[axis];
      return {
        command: 'cuboid.update',
        params: { ids, from: withAxis(from, axis, value), to: withAxis(to, axis, to[axis] + shift), origin: withAxis(origin, axis, origin[axis] + shift) },
      };
    }
    case 'size':
      return { command: 'cuboid.update', params: { ids, from, to: withAxis(to, axis, from[axis] + value) } };
    case 'pivot':
      return { command: 'cuboid.set_pivot', params: { ids, origin: withAxis(origin, axis, value) } };
    case 'rotation':
      return { command: 'cuboid.update', params: { ids, rotation: withAxis(obj.transform.rotation, axis, value) } };
  }
}

