import type { DocState, Modifier, PolyMesh, SceneObject, Transform } from '../types';
import { array } from './array';
import { boolean, initManifold, manifoldReady, relativeMatrix } from './boolean';
import { mirror } from './mirror';
import { subdivide } from './subdivide';

export interface Evaluated {
  /** The object's mesh after all enabled modifiers, in the object's local space. */
  mesh: PolyMesh;
  /** Error message per modifier id for modifiers that failed and were skipped. */
  errors: Readonly<Record<string, string>>;
}

/** What a boolean modifier operates with, or the reason why it cannot. */
type Target = { transform: Transform; evaluated: Evaluated } | string;

/** True if `fromId` depends on `toId` through enabled boolean modifiers. */
function dependsOn(state: DocState, fromId: string, toId: string, seen = new Set<string>()): boolean {
  if (fromId === toId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  return (state.objects[fromId]?.modifiers ?? []).some(
    (m) => m.type === 'boolean' && m.enabled && m.targetId !== null && dependsOn(state, m.targetId, toId, seen),
  );
}

function resolveTarget(state: DocState, object: SceneObject, targetId: string | null): Target {
  if (targetId === null) return 'No target object is set';
  if (targetId === object.id) return 'An object cannot be its own boolean target';
  const target = state.objects[targetId];
  if (!target) return `The target object "${targetId}" does not exist`;
  if (dependsOn(state, targetId, object.id)) return 'The boolean targets form a cycle (the target depends on this object)';
  return { transform: target.transform, evaluated: evaluateObject(state, targetId) };
}

function sameTarget(a: Target, b: Target): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.transform === b.transform && a.evaluated === b.evaluated;
}

function applyResolved(object: SceneObject, mesh: PolyMesh, modifier: Modifier, target: Target | null): PolyMesh {
  switch (modifier.type) {
    case 'mirror':
      return mirror(mesh, modifier.axes, modifier.mergeDistance);
    case 'subdivision':
      return subdivide(mesh, modifier.levels);
    case 'array':
      return array(mesh, modifier.count, modifier.offset);
    case 'boolean': {
      if (typeof target === 'string') throw new Error(target);
      const matrix = relativeMatrix(target!.transform, object.transform);
      if (!matrix) throw new Error('The object has a scale of zero');
      return boolean(mesh, target!.evaluated.mesh, matrix, modifier.operation);
    }
  }
}

/** Applies one modifier of `object` to `mesh` (in the object's local space). Throws if it cannot be applied. */
export function applyModifier(state: DocState, object: SceneObject, mesh: PolyMesh, modifier: Modifier): PolyMesh {
  const target = modifier.type === 'boolean' ? resolveTarget(state, object, modifier.targetId) : null;
  return applyResolved(object, mesh, modifier, target);
}

interface CacheEntry {
  objectId: string;
  mesh: PolyMesh;
  transform: Transform;
  /** Whether the WASM was loaded when this was computed. */
  ready: boolean;
  /** One per enabled boolean modifier, in stack order. Empty: the result depends on mesh + modifiers only. */
  targets: Target[];
  result: Evaluated;
}

// Unchanged objects keep their identity across state changes, so identity is the cache key. The
// second map keeps results alive across changes that do not matter here (rename, visibility, and
// the transform unless a boolean is involved).
const byObject = new WeakMap<SceneObject, CacheEntry>();
const byModifiers = new WeakMap<readonly Modifier[], CacheEntry>();
const unmodified = new WeakMap<PolyMesh, Evaluated>();

function isValid(entry: CacheEntry | undefined, state: DocState, object: SceneObject): entry is CacheEntry {
  if (!entry || entry.mesh !== object.mesh) return false;
  if (entry.targets.length === 0) return true;
  if (entry.objectId !== object.id || entry.transform !== object.transform || entry.ready !== manifoldReady()) return false;
  let i = 0;
  for (const m of object.modifiers) {
    if (m.type === 'boolean' && m.enabled && !sameTarget(entry.targets[i++], resolveTarget(state, object, m.targetId))) return false;
  }
  return true;
}

/**
 * Evaluates an object's modifier stack. Cached: repeated calls with unchanged inputs return the
 * same `Evaluated` object, and an object without enabled modifiers returns its base mesh itself.
 * Modifiers that fail (see `errors`) are skipped. Boolean modifiers need `initModifiers()` to have
 * resolved; until then they are skipped with an error, and the next call after it returns a new result.
 */
export function evaluateObject(state: DocState, objectId: string): Evaluated {
  const object = state.objects[objectId];
  if (!object) throw new Error(`Object "${objectId}" does not exist`);
  const enabled = object.modifiers.filter((m) => m.enabled);
  if (enabled.length === 0) {
    let plain = unmodified.get(object.mesh);
    if (!plain) unmodified.set(object.mesh, (plain = { mesh: object.mesh, errors: {} }));
    return plain;
  }

  let entry = byObject.get(object);
  if (!isValid(entry, state, object)) {
    entry = byModifiers.get(object.modifiers);
    if (!isValid(entry, state, object)) {
      const ready = manifoldReady();
      const targets: Target[] = [];
      const errors: Record<string, string> = {};
      let mesh = object.mesh;
      for (const modifier of enabled) {
        let target: Target | null = null;
        if (modifier.type === 'boolean') targets.push((target = resolveTarget(state, object, modifier.targetId)));
        try {
          mesh = applyResolved(object, mesh, modifier, target);
        } catch (error) {
          errors[modifier.id] = error instanceof Error ? error.message : String(error);
        }
      }
      entry = { objectId, mesh: object.mesh, transform: object.transform, ready, targets, result: { mesh, errors } };
      byModifiers.set(object.modifiers, entry);
    }
    byObject.set(object, entry);
  }
  return entry.result;
}

/** Loads what boolean modifiers need (WASM). Resolves immediately once loaded. */
export function initModifiers(): Promise<void> {
  return initManifold();
}
