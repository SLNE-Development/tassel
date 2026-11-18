// STUB — replaced by the real modifier evaluation.
import type { DocState, PolyMesh } from '../types';

export interface Evaluated {
  /** The object's mesh after all enabled modifiers, in the object's local space. */
  mesh: PolyMesh;
  /** Error message per modifier id for modifiers that failed and were skipped. */
  errors: Readonly<Record<string, string>>;
}

/**
 * Evaluates an object's modifier stack. Cached: repeated calls with unchanged inputs return the
 * same `Evaluated` object, and an object without enabled modifiers returns its base mesh itself.
 */
export function evaluateObject(state: DocState, objectId: string): Evaluated {
  return { mesh: state.objects[objectId].mesh, errors: {} };
}

/** Loads what boolean modifiers need (WASM). Resolves immediately once loaded. */
export async function initModifiers(): Promise<void> {}
