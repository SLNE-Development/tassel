// glTF only has triangles. To get polygons back, the exporter notes each mesh's polygon structure in the
// primitive's `extras.tessel.polygons`; other applications ignore `extras`, so the file stays a normal glTF.
//
//   runs:  [n, count, n, count, ...]  vertex count of the polygons in the order of their triangles, run-length
//          encoded: `count` polygons with `n` corners each. A polygon with n corners owns the next n - 2 triangles.
//   loops: [face, v0, ..., v(n-1), face, ...]  only for polygons that were not triangulated as a fan from their
//          first corner (concave ones): the polygon's index (increasing) and its corners in order, as indices
//          into the primitive's vertices.
//
// A fan polygon needs no loop: its triangles are (v0 v1 v2) (v0 v2 v3) ..., which gives the corners back.
// Corner UVs come from the vertices the corners point at.
import { triangulateFaceCorners } from '../core/mesh/polymesh';
import type { PolyMesh } from '../core/types';

export interface PolygonExtra {
  runs: number[];
  loops?: number[];
}

/**
 * The polygon structure of a mesh for its triangle indices as `indexedTriangles` wrote them. Null if there
 * is nothing to note (all triangles) or the mesh has a face that cannot be described (a corner twice).
 */
export function polygonExtra(mesh: PolyMesh, indices: ArrayLike<number>): PolygonExtra | null {
  if (mesh.faces.every((face) => face.length === 3)) return null;
  const runs: number[] = [];
  const loops: number[] = [];
  const corners: number[] = [];
  let t = 0;
  for (let f = 0; f < mesh.faces.length; f++) {
    const face = mesh.faces[f];
    const n = face.length;
    corners.length = 0;
    triangulateFaceCorners(mesh, face, corners);
    if (corners.length !== (n - 2) * 3 || (t + n - 2) * 3 > indices.length) return null;
    // The written vertex of every corner of the face.
    const loop = new Array<number>(n).fill(-1);
    let fan = true;
    for (let c = 0; c < corners.length; c++) {
      const vertex = indices[t * 3 + c];
      if (loop[corners[c]] !== -1 && loop[corners[c]] !== vertex) return null;
      loop[corners[c]] = vertex;
      if (corners[c] !== (c % 3 === 0 ? 0 : Math.floor(c / 3) + (c % 3))) fan = false;
    }
    if (loop.includes(-1) || new Set(loop).size !== n) return null;
    if (!fan) loops.push(f, ...loop);
    if (runs.length > 0 && runs[runs.length - 2] === n) runs[runs.length - 1]++;
    else runs.push(n, 1);
    t += n - 2;
  }
  if (t * 3 !== indices.length) return null;
  return loops.length > 0 ? { runs, loops } : { runs };
}

const isIndex = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;

/**
 * Reads the polygon structure back: the polygons as loops of vertex indices, in order. The data is
 * untrusted, so it must fit the triangles exactly: the runs account for every triangle, a fan polygon's
 * triangles really are a fan, a listed loop's triangles use only its corners in its direction and cover
 * all of them, and no polygon has a corner twice. Otherwise the result is a sentence saying what is wrong.
 */
export function polygonLoops(extra: unknown, indices: ArrayLike<number> | null, vertexCount: number): number[][] | string {
  if (!indices || indices.length % 3 !== 0) return 'the mesh has no usable index list';
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return 'it is not an object';
  const { runs, loops } = extra as { runs?: unknown; loops?: unknown };
  if (!Array.isArray(runs) || runs.length === 0 || runs.length % 2 !== 0) return '"runs" is not a list of pairs';
  const triangles = indices.length / 3;
  let faceCount = 0;
  let counted = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const n = runs[i];
    const count = runs[i + 1];
    if (!isIndex(n) || n < 3 || !isIndex(count) || count < 1) return '"runs" holds an invalid pair';
    counted += (n - 2) * count;
    faceCount += count;
    // Also keeps absurd counts from being expanded below.
    if (counted > triangles) return `it describes more than the mesh's ${triangles} triangles`;
  }
  if (counted !== triangles) return `it describes ${counted} triangles, but the mesh has ${triangles}`;
  const sizes = new Uint32Array(faceCount);
  for (let i = 0, f = 0; i < runs.length; i += 2) for (let k = 0; k < runs[i + 1]; k++) sizes[f++] = runs[i];

  const explicit = new Map<number, number[]>();
  if (loops !== undefined) {
    if (!Array.isArray(loops)) return '"loops" is not a list';
    let last = -1;
    for (let i = 0; i < loops.length; ) {
      const face = loops[i];
      if (!isIndex(face) || face <= last || face >= faceCount) return '"loops" names an invalid polygon';
      const loop = loops.slice(i + 1, i + 1 + sizes[face]) as unknown[];
      if (loop.length !== sizes[face] || !loop.every(isIndex)) return '"loops" is cut off or holds an invalid vertex';
      explicit.set(face, loop as number[]);
      last = face;
      i += 1 + sizes[face];
    }
  }

  const faces: number[][] = [];
  let t = 0;
  for (let f = 0; f < faceCount; f++) {
    const n = sizes[f];
    let loop = explicit.get(f);
    if (loop) {
      const at = new Map(loop.map((vertex, k) => [vertex, k]));
      if (at.size !== n) return `polygon ${f} has a corner twice`;
      const used = new Set<number>();
      for (let k = 0; k < n - 2; k++) {
        const a = at.get(indices[(t + k) * 3]);
        const b = at.get(indices[(t + k) * 3 + 1]);
        const c = at.get(indices[(t + k) * 3 + 2]);
        if (a === undefined || b === undefined || c === undefined) return `a triangle of polygon ${f} uses a vertex that is not one of its corners`;
        // In the polygon's direction: going round from a, b comes before c.
        const ab = (b - a + n) % n;
        const ac = (c - a + n) % n;
        if (ab === 0 || ac === 0 || ab >= ac) return `a triangle of polygon ${f} does not follow the polygon's direction`;
        used.add(a).add(b).add(c);
      }
      if (used.size !== n) return `the triangles of polygon ${f} do not cover its corners`;
    } else {
      loop = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      for (let k = 1; k < n - 2; k++) {
        const at = (t + k) * 3;
        if (indices[at] !== loop[0] || indices[at + 1] !== loop[loop.length - 1]) return `the triangles of polygon ${f} are not a fan`;
        loop.push(indices[at + 2]);
      }
      if (n > 3 && new Set(loop).size !== n) return `polygon ${f} has a corner twice`;
    }
    for (const vertex of loop) if (!(vertex < vertexCount)) return `polygon ${f} uses a vertex that does not exist`;
    faces.push(loop);
    t += n - 2;
  }
  return faces;
}
