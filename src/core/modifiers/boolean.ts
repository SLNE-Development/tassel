import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { faceNormal } from '../mesh/polymesh';
import type { BooleanOperation, PolyMesh, Transform } from '../types';

let lib: ManifoldToplevel | null = null;
let loading: Promise<void> | null = null;

/** Loads the manifold WASM module once. */
export function initManifold(): Promise<void> {
  loading ??= (async () => {
    // Node (vitest) reads manifold.wasm from the package next to manifold.js; in the browser the
    // file is a Vite asset whose final URL only the `?url` import knows.
    const isNode = typeof process !== 'undefined' && !!process.versions?.node;
    const module = await Module(isNode ? undefined : { locateFile: () => wasmUrl });
    module.setup();
    lib = module;
  })().catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export function manifoldReady(): boolean {
  return lib !== null;
}

/** Affine matrix, row-major 3x4: [m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz]. */
export type Mat = readonly number[];

/** Local-to-world matrix T * R * S with R = Rx * Ry * Rz (Euler XYZ in degrees, as three.js). */
export function transformMatrix(t: Transform): Mat {
  const [x, y, z] = t.rotation.map((deg) => (deg * Math.PI) / 180);
  const [a, b, c, d, e, f] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
  const [sx, sy, sz] = t.scale;
  // prettier-ignore
  return [
    c * e * sx,               -c * f * sy,              d * sz,      t.position[0],
    (a * f + b * e * d) * sx, (a * e - b * f * d) * sy, -b * c * sz, t.position[1],
    (b * f - a * e * d) * sx, (b * e + a * f * d) * sy, a * c * sz,  t.position[2],
  ];
}

function determinant(m: Mat): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

/** Matrix taking points from the local space of `from` into the local space of `to`, or null if `to` has a zero scale. */
export function relativeMatrix(from: Transform, to: Transform): Mat | null {
  const m = transformMatrix(to);
  const det = determinant(m);
  if (Math.abs(det) < 1e-12) return null;
  // prettier-ignore
  const inv = [
    (m[5] * m[10] - m[6] * m[9]) / det, (m[2] * m[9] - m[1] * m[10]) / det, (m[1] * m[6] - m[2] * m[5]) / det,
    (m[6] * m[8] - m[4] * m[10]) / det, (m[0] * m[10] - m[2] * m[8]) / det, (m[2] * m[4] - m[0] * m[6]) / det,
    (m[4] * m[9] - m[5] * m[8]) / det,  (m[1] * m[8] - m[0] * m[9]) / det,  (m[0] * m[5] - m[1] * m[4]) / det,
  ];
  const f = transformMatrix(from);
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      // inv * [f | ft], with the translation column additionally shifted by -inv * mt.
      let v = inv[r * 3] * f[c] + inv[r * 3 + 1] * f[4 + c] + inv[r * 3 + 2] * f[8 + c];
      if (c === 3) v -= inv[r * 3] * m[3] + inv[r * 3 + 1] * m[7] + inv[r * 3 + 2] * m[11];
      out.push(v);
    }
  }
  return out;
}

/** Ear clipping of one face (handles concave polygons); appends vertex index triples to `out`. */
function triangulateFace(mesh: PolyMesh, face: readonly number[], out: number[]): void {
  if (face.length === 3) {
    out.push(face[0], face[1], face[2]);
    return;
  }
  // Project onto the plane most perpendicular to the normal, keeping the loop counter-clockwise.
  const n = faceNormal(mesh, face);
  const drop = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
  const ua = (drop + 1) % 3;
  const va = (drop + 2) % 3;
  const sign = n[drop] < 0 ? -1 : 1;
  const u = (v: number) => mesh.positions[v * 3 + ua] * sign;
  const w = (v: number) => mesh.positions[v * 3 + va];
  const cross = (a: number, b: number, c: number) => (u(b) - u(a)) * (w(c) - w(a)) - (w(b) - w(a)) * (u(c) - u(a));

  const loop = [...face];
  while (loop.length > 3) {
    let ear = -1;
    for (let i = 0; i < loop.length && ear === -1; i++) {
      const a = loop[(i + loop.length - 1) % loop.length];
      const b = loop[i];
      const c = loop[(i + 1) % loop.length];
      if (cross(a, b, c) <= 0) continue;
      const blocked = loop.some(
        (p) => p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0,
      );
      if (!blocked) ear = i;
    }
    if (ear === -1) break; // degenerate face: fan the rest
    out.push(loop[(ear + loop.length - 1) % loop.length], loop[ear], loop[(ear + 1) % loop.length]);
    loop.splice(ear, 1);
  }
  for (let i = 1; i < loop.length - 1; i++) out.push(loop[0], loop[i], loop[i + 1]);
}

function toManifold(m: ManifoldToplevel, mesh: PolyMesh, matrix: Mat | null, what: string): Manifold {
  if (mesh.faces.length === 0) throw new Error(`${what} has no faces`);
  const triVerts: number[] = [];
  for (const face of mesh.faces) triangulateFace(mesh, face, triVerts);
  const vertProperties = new Float32Array(mesh.positions.length);
  if (matrix) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let r = 0; r < 3; r++) {
        vertProperties[i + r] = matrix[r * 4] * p[i] + matrix[r * 4 + 1] * p[i + 1] + matrix[r * 4 + 2] * p[i + 2] + matrix[r * 4 + 3];
      }
    }
    // A mirroring matrix turns the mesh inside out; flip the triangles back.
    if (determinant(matrix) < 0) {
      for (let i = 0; i < triVerts.length; i += 3) [triVerts[i + 1], triVerts[i + 2]] = [triVerts[i + 2], triVerts[i + 1]];
    }
  } else {
    vertProperties.set(mesh.positions);
  }
  const input = new m.Mesh({ numProp: 3, vertProperties, triVerts: new Uint32Array(triVerts) });
  input.merge(); // welds coincident vertices along open seams, if that makes it manifold
  let solid: Manifold;
  try {
    solid = new m.Manifold(input);
  } catch {
    throw new Error(`${what} is not a closed manifold mesh (it has holes, open edges or edges shared by more than two faces)`);
  }
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new Error(`${what} is not a closed manifold mesh (${status})`);
  }
  return solid;
}

/**
 * `mesh` (operation) `target`, both closed manifolds. `targetMatrix` takes the target's points into
 * the space of `mesh`. The result is triangulated. Throws if the WASM is not loaded yet or an input
 * is not a valid manifold.
 */
export function boolean(mesh: PolyMesh, target: PolyMesh, targetMatrix: Mat, operation: BooleanOperation): PolyMesh {
  if (!lib) throw new Error('The boolean engine is still loading');
  const a = toManifold(lib, mesh, null, 'The mesh');
  let b: Manifold | null = null;
  let result: Manifold | null = null;
  try {
    b = toManifold(lib, target, targetMatrix, 'The target mesh');
    result = operation === 'union' ? a.add(b) : operation === 'difference' ? a.subtract(b) : a.intersect(b);
    const out = result.getMesh();
    const positions: number[] = [];
    for (let i = 0; i < out.vertProperties.length; i += out.numProp) {
      positions.push(out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2]);
    }
    const faces: number[][] = [];
    for (let i = 0; i < out.triVerts.length; i += 3) faces.push([out.triVerts[i], out.triVerts[i + 1], out.triVerts[i + 2]]);
    return { positions, faces };
  } finally {
    a.delete();
    b?.delete();
    result?.delete();
  }
}
