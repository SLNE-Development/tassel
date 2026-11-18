import type { Edge, PolyMesh } from '../../types';
import { edgeFaces, edgeKey, makeEdge } from '../topology';
import type { MeshOpResult } from './types';

function requireEdge(faces: Map<string, number[]>, edge: Edge): void {
  if (!faces.has(edgeKey(edge[0], edge[1]))) {
    throw new Error(`${edge[0]}-${edge[1]} is not an edge of the mesh.`);
  }
}

/** The edge loop through `edge`: continues straight across vertices with four edges. Includes `edge`. */
export function edgeLoop(mesh: PolyMesh, edge: Edge): Edge[] {
  const faces = edgeFaces(mesh);
  requireEdge(faces, edge);
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    const set = neighbours.get(a);
    if (set) set.add(b);
    else neighbours.set(a, new Set([b]));
  };
  for (const face of mesh.faces) {
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      link(a, b);
      link(b, a);
    });
  }

  const visited = new Set([edgeKey(edge[0], edge[1])]);
  /** Walks on from the edge from->to past `to` and returns the edges found, in walking order. */
  const walk = (from: number, to: number): Edge[] => {
    const out: Edge[] = [];
    for (;;) {
      const around = [...neighbours.get(to)!];
      // Straight on is only defined at an interior vertex with exactly four edges.
      if (around.length !== 4 || around.some((x) => faces.get(edgeKey(to, x))!.length !== 2)) return out;
      const current = faces.get(edgeKey(from, to))!;
      const ahead = around.filter((x) => x !== from && !faces.get(edgeKey(to, x))!.some((f) => current.includes(f)));
      if (ahead.length !== 1) return out;
      const key = edgeKey(to, ahead[0]);
      if (visited.has(key)) return out; // the loop closed
      visited.add(key);
      out.push(makeEdge(to, ahead[0]));
      from = to;
      to = ahead[0];
    }
  };
  const forward = walk(edge[0], edge[1]);
  const backward = walk(edge[1], edge[0]);
  return [...backward.reverse(), makeEdge(edge[0], edge[1]), ...forward];
}

/** The edge ring through `edge`: the opposite edges across consecutive quads. Includes `edge`. */
export function edgeRing(mesh: PolyMesh, edge: Edge): Edge[] {
  const faces = edgeFaces(mesh);
  requireEdge(faces, edge);
  const visited = new Set([edgeKey(edge[0], edge[1])]);
  /** Crosses face `fi` from the edge a-b and keeps going; returns the edges found, in walking order. */
  const walk = (a: number, b: number, fi: number): Edge[] => {
    const out: Edge[] = [];
    for (;;) {
      const face = mesh.faces[fi];
      if (face.length !== 4) return out;
      const i = face.findIndex((v, k) => edgeKey(v, face[(k + 1) % 4]) === edgeKey(a, b));
      a = face[(i + 2) % 4];
      b = face[(i + 3) % 4];
      const key = edgeKey(a, b);
      if (visited.has(key)) return out; // the ring closed
      visited.add(key);
      out.push(makeEdge(a, b));
      const pair = faces.get(key)!;
      if (pair.length !== 2) return out; // boundary (or non-manifold) edge
      fi = pair[0] === fi ? pair[1] : pair[0];
    }
  };
  const [first, second] = faces.get(edgeKey(edge[0], edge[1]))!;
  const forward = walk(edge[0], edge[1], first);
  const backward = second === undefined ? [] : walk(edge[0], edge[1], second);
  return [...backward.reverse(), makeEdge(edge[0], edge[1]), ...forward];
}

/** Cuts the ring of quads through `edge` with `cuts` evenly spaced new edge loops. Selects the new edges. */
export function loopCut(mesh: PolyMesh, edge: Edge, cuts: number): MeshOpResult {
  if (!Number.isInteger(cuts) || cuts < 1) throw new Error('The number of cuts must be a whole number of at least 1.');
  const faces = edgeFaces(mesh);
  requireEdge(faces, edge);
  if (!faces.get(edgeKey(edge[0], edge[1]))!.some((f) => mesh.faces[f].length === 4)) {
    throw new Error(`Cannot loop cut: edge ${edge[0]}-${edge[1]} has no adjacent quad.`);
  }

  // `cuts` new vertices on every ring edge, stored from the lower to the higher vertex index.
  const positions = [...mesh.positions];
  const split = new Map<string, number[]>();
  for (const [a, b] of edgeRing(mesh, edge)) {
    const added: number[] = [];
    for (let j = 1; j <= cuts; j++) {
      const t = j / (cuts + 1);
      added.push(positions.length / 3);
      for (let c = 0; c < 3; c++) positions.push(mesh.positions[a * 3 + c] * (1 - t) + mesh.positions[b * 3 + c] * t);
    }
    split.set(edgeKey(a, b), added);
  }
  /** The vertex j steps of 1 / (cuts + 1) along the ring edge from u to v. */
  const pointOn = (u: number, v: number, j: number): number => {
    if (j === 0) return u;
    if (j === cuts + 1) return v;
    const added = split.get(edgeKey(u, v))!;
    return u < v ? added[j - 1] : added[cuts - j];
  };

  const outFaces: number[][] = mesh.faces.map((f) => [...f]);
  const newEdges: Edge[] = [];
  mesh.faces.forEach((face, fi) => {
    const n = face.length;
    const inRing = face.map((v, i) => split.has(edgeKey(v, face[(i + 1) % n])));
    if (!inRing.includes(true)) return;
    if (n === 4 && inRing.every(Boolean)) throw new Error('Cannot loop cut: the edge ring crosses itself.');
    const i = inRing.indexOf(true);
    if (n === 4 && inRing[(i + 2) % 4]) {
      // A quad of the ring: cuts + 1 quads between its two ring edges v0-v1 and v3-v2.
      const [v0, v1, v2, v3] = [0, 1, 2, 3].map((k) => face[(i + k) % 4]);
      for (let j = 0; j <= cuts; j++) {
        const quad = [pointOn(v0, v1, j), pointOn(v0, v1, j + 1), pointOn(v3, v2, j + 1), pointOn(v3, v2, j)];
        if (j === 0) outFaces[fi] = quad;
        else outFaces.push(quad);
        if (j > 0) newEdges.push(makeEdge(quad[0], quad[3]));
      }
      return;
    }
    // A face at the end of an open ring: it only gets the new vertices inserted into its loop.
    outFaces[fi] = face.flatMap((v, k) => {
      if (!inRing[k]) return [v];
      const w = face[(k + 1) % n];
      return [v, ...Array.from({ length: cuts }, (_, j) => pointOn(v, w, j + 1))];
    });
  });
  return { mesh: { positions, faces: outFaces }, edges: newEdges };
}
