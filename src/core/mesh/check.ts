// Manifold check for meshes that come from outside (scene.add_mesh): tells the caller in words what is
// wrong with a mesh, so that an AI client learns about a hole or a flipped face without looking at it.
import type { PolyMesh } from '../types';
import { newell } from './polymesh';

export interface MeshCheck {
  /** Every edge is shared by exactly two faces (a watertight surface). */
  closed: boolean;
  /** Edges with only one face. */
  openEdges: number;
  /** Edges shared by more than two faces. */
  nonManifoldEdges: number;
  /** Faces wound against their surroundings (for closed parts: pointing inwards). */
  flippedFaceCount: number;
  /** The first of them (at most 20), as face indices. */
  flippedFaces: number[];
  /** Faces without area. */
  degenerateFaces: number;
  /** Vertices no face uses. */
  unusedVertices: number;
  /** Everything above in English sentences; empty for a clean closed mesh. */
  warnings: string[];
}

const MAX_LISTED = 20;

/** Six times the signed volume of the fan of a face seen from the origin. */
function faceVolume(p: readonly number[], face: readonly number[]): number {
  let sum = 0;
  for (let i = 1; i < face.length - 1; i++) {
    const a = face[0] * 3;
    const b = face[i] * 3;
    const c = face[i + 1] * 3;
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum;
}

export function checkMesh(mesh: PolyMesh): MeshCheck {
  const p = mesh.positions;
  const vertexCount = p.length / 3;
  const faces = mesh.faces;

  // Per undirected edge: its uses as face * 2 + direction (0 = from the lower to the higher vertex index).
  const uses = new Map<number, number[]>();
  const used = new Uint8Array(vertexCount);
  let degenerateFaces = 0;
  let scale = 0;
  for (let i = 0; i < p.length; i++) scale = Math.max(scale, Math.abs(p[i]));
  faces.forEach((face, f) => {
    const n = newell(p, face);
    if (Math.hypot(n[0], n[1], n[2]) <= 1e-12 * Math.max(1, scale * scale)) degenerateFaces++;
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      used[a] = 1;
      if (a === b) continue;
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      const list = uses.get(key);
      const entry = f * 2 + (a < b ? 0 : 1);
      if (list) list.push(entry);
      else uses.set(key, [entry]);
    }
  });

  let openEdges = 0;
  let nonManifoldEdges = 0;
  let firstOpen = -1;
  const openFace = new Uint8Array(faces.length);
  // Neighbours across edges with exactly two faces: other face * 2 + (1 if the two run along the edge the same way, i.e. disagree).
  const neighbours: number[][] = faces.map(() => []);
  for (const [key, list] of uses) {
    if (list.length === 1) {
      openEdges++;
      if (firstOpen < 0) firstOpen = key;
      openFace[list[0] >> 1] = 1;
    } else if (list.length > 2) {
      nonManifoldEdges++;
      for (const entry of list) openFace[entry >> 1] = 1;
    } else {
      const [x, y] = list;
      if (x >> 1 === y >> 1) continue;
      const disagree = (x & 1) === (y & 1) ? 1 : 0;
      neighbours[x >> 1].push((y >> 1) * 2 + disagree);
      neighbours[y >> 1].push((x >> 1) * 2 + disagree);
    }
  }

  // Flood every connected part with a consistent orientation; the faces on the wrong side of it are flipped.
  const parity = new Int8Array(faces.length).fill(-1);
  const flipped: number[] = [];
  let unorientable = false;
  for (let start = 0; start < faces.length; start++) {
    if (parity[start] !== -1) continue;
    parity[start] = 0;
    const part = [start];
    let volume = 0;
    let closed = true;
    for (let i = 0; i < part.length; i++) {
      const f = part[i];
      if (openFace[f]) closed = false;
      volume += (parity[f] ? -1 : 1) * faceVolume(p, faces[f]);
      for (const n of neighbours[f]) {
        const other = n >> 1;
        const expected = parity[f] ^ (n & 1);
        if (parity[other] === -1) {
          parity[other] = expected;
          part.push(other);
        } else if (parity[other] !== expected) unorientable = true;
      }
    }
    let odd = 0;
    for (const f of part) odd += parity[f];
    // Closed part: the orientation with positive volume faces outwards. Open part: the majority is right.
    const wrong = closed && Math.abs(volume) > 1e-12 ? (volume < 0 ? 0 : 1) : odd * 2 > part.length ? 0 : 1;
    for (const f of part) if (parity[f] === wrong) flipped.push(f);
  }
  flipped.sort((a, b) => a - b);

  let unusedVertices = 0;
  for (let v = 0; v < vertexCount; v++) if (!used[v]) unusedVertices++;

  const warnings: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (openEdges > 0) {
    const a = Math.floor(firstOpen / vertexCount);
    warnings.push(
      `The mesh is not closed: ${plural(openEdges, 'edge has', 'edges have')} only one face (e.g. the edge between vertices ${a} and ${firstOpen - a * vertexCount}). That is fine for a sheet such as a plane, but boolean operations need closed meshes.`,
    );
  }
  if (nonManifoldEdges > 0) {
    warnings.push(`${plural(nonManifoldEdges, 'edge is', 'edges are')} shared by more than two faces (non-manifold).`);
  }
  if (flipped.length > 0) {
    const shown = flipped.slice(0, MAX_LISTED).join(', ') + (flipped.length > MAX_LISTED ? ', ...' : '');
    warnings.push(
      flipped.length === faces.length
        ? 'The mesh is inside out: all faces are wound clockwise seen from outside, so their normals point inwards. Reverse the vertex order of every face (faces must be counter-clockwise seen from outside).'
        : `Inconsistent winding: ${plural(flipped.length, 'face is', 'faces are')} wound opposite to the rest, so ${flipped.length === 1 ? 'its normal points' : 'their normals point'} the wrong way (face ${flipped.length === 1 ? 'index' : 'indices'}: ${shown}). Reverse the vertex order of these faces.`,
    );
  }
  if (unorientable) warnings.push('The faces cannot be oriented consistently (the surface is one-sided like a Möbius strip, or badly connected).');
  if (degenerateFaces > 0) warnings.push(`${plural(degenerateFaces, 'face has', 'faces have')} no area (collinear or coincident vertices).`);
  if (unusedVertices > 0) warnings.push(`${plural(unusedVertices, 'vertex is', 'vertices are')} not used by any face.`);

  return {
    closed: faces.length > 0 && openEdges === 0 && nonManifoldEdges === 0,
    openEdges,
    nonManifoldEdges,
    flippedFaceCount: flipped.length,
    flippedFaces: flipped.slice(0, MAX_LISTED),
    degenerateFaces,
    unusedVertices,
    warnings,
  };
}
