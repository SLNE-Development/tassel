import type { Edge, PolyMesh } from '../../types';
import { edges as meshEdges } from '../polymesh';
import { edgeFaces, edgeKey } from '../topology';
import type { MeshOpResult } from './types';

const unsuitable =
  'Cannot fill: the selection must be the open edges around one hole (a closed loop), or one open chain of edges that the new face closes. ' +
  'Open edges are edges with fewer than two faces.';

/**
 * Creates one face from a loop of open edges (edges with fewer than two faces), e.g. around a hole,
 * or from one open chain of such edges, which the new face closes with one new edge.
 * `edges` are the edges to use; null = all open edges between the given vertices.
 * The face is wound to match its neighbours. Selects the new face.
 */
export function fillFace(mesh: PolyMesh, vertices: readonly number[], edges: readonly Edge[] | null): MeshOpResult {
  const faceCount = edgeFaces(mesh);
  const uses = (a: number, b: number) => faceCount.get(edgeKey(a, b))?.length ?? 0;

  let outline: readonly Edge[];
  let corners: number[];
  if (edges) {
    for (const [a, b] of edges) {
      if (uses(a, b) === 0) throw new Error(`The mesh has no edge between vertices ${a} and ${b}`);
      if (uses(a, b) >= 2) throw new Error(`Cannot fill: edge ${a}-${b} already has two faces, so there is no hole next to it`);
    }
    outline = edges;
    corners = [...new Set(edges.flat())];
  } else {
    const set = new Set(vertices);
    outline = meshEdges(mesh).filter(([a, b]) => set.has(a) && set.has(b) && uses(a, b) < 2);
    corners = [...set];
  }
  if (corners.length < 3) throw new Error('Cannot fill: a face needs at least three vertices');

  const neighbours = new Map<number, number[]>(corners.map((v) => [v, []]));
  for (const [a, b] of outline) {
    neighbours.get(a)!.push(b);
    neighbours.get(b)!.push(a);
  }
  const ends = corners.filter((v) => neighbours.get(v)!.length === 1);
  if (corners.some((v) => neighbours.get(v)!.length === 0 || neighbours.get(v)!.length > 2) || (ends.length !== 0 && ends.length !== 2)) {
    throw new Error(unsuitable);
  }

  // Walk along the outline, starting at an end of the chain if it is open.
  const loop: number[] = [];
  let previous = -1;
  let current = ends[0] ?? corners[0];
  while (current !== undefined && current !== loop[0]) {
    loop.push(current);
    const next: number | undefined = neighbours.get(current)!.find((v) => v !== previous);
    previous = current;
    current = next!;
  }
  // Two separate loops (or a loop and a chain) leave vertices unvisited.
  if (loop.length !== corners.length) throw new Error(unsuitable);
  if (ends.length === 2 && uses(loop[0], loop[loop.length - 1]) >= 2) throw new Error(unsuitable);

  // A neighbouring face that runs a -> b along an edge needs the new face to run b -> a.
  const directed = new Set<string>();
  for (const face of mesh.faces) face.forEach((a, i) => directed.add(`${a}>${face[(i + 1) % face.length]}`));
  let same = 0;
  let opposite = 0;
  loop.forEach((a, i) => {
    const b = loop[(i + 1) % loop.length];
    if (directed.has(`${a}>${b}`)) same++;
    if (directed.has(`${b}>${a}`)) opposite++;
  });
  if (same > opposite) loop.reverse();

  return { mesh: { positions: mesh.positions, faces: [...mesh.faces, loop] }, faces: [mesh.faces.length] };
}
