import type { PolyMesh, Vec3 } from '../../types';
import { faceNormal } from '../polymesh';
import { edgeKey } from '../topology';
import type { MeshOpResult } from './types';
import { add, cross, dot, dropUnused, length, normalize, position, scale, sub } from './util';

interface Copy {
  /** Index of the duplicated vertex. */
  index: number;
  /** The vertex (of the input mesh) it is a copy of. */
  origin: number;
  /** The region faces around the origin that use this copy. */
  faces: number[];
}

interface Region {
  copies: Copy[];
  /** Directed edges (in the winding of their face) on the outline of the region, with the copies of their ends. */
  boundary: { a: number; b: number; face: number; copyA: number; copyB: number }[];
}

/**
 * The topology shared by extrude and inset. Every group of faces is a region: its vertices are
 * duplicated (the copies start at the same place), its faces move to the copies, and every edge on
 * the region's outline gets a side quad between the original edge and its copy. Edges inside a
 * region are not duplicated. An outline edge is one used by exactly one face of the region, so the
 * rim of an open mesh gets side quads too. Where parts of a region touch in a single vertex, each
 * part gets its own copy of that vertex; otherwise four side quads would meet in one edge.
 */
function duplicateRegions(mesh: PolyMesh, groups: readonly (readonly number[])[]): { positions: number[]; faces: number[][]; regions: Region[] } {
  const positions = [...mesh.positions];
  const faces = mesh.faces.map((f) => [...f]);
  const regions = groups.map((group): Region => {
    const uses = new Map<string, number>();
    const around = new Map<number, number[]>(); // region vertex -> region faces using it
    for (const f of group) {
      const face = mesh.faces[f];
      face.forEach((v, i) => {
        const key = edgeKey(v, face[(i + 1) % face.length]);
        uses.set(key, (uses.get(key) ?? 0) + 1);
        const list = around.get(v);
        if (list) list.push(f);
        else around.set(v, [f]);
      });
    }

    const copies: Copy[] = [];
    const copyOf = new Map<string, number>(); // `${face}:${vertex}` -> copy index
    for (const [v, list] of around) {
      // Faces around v belong together when they share an edge at v.
      const part = list.map((_, i) => i);
      const find = (i: number): number => (part[i] === i ? i : (part[i] = find(part[i])));
      const byNeighbour = new Map<number, number>();
      list.forEach((f, i) => {
        const face = mesh.faces[f];
        const at = face.indexOf(v);
        for (const other of [face[(at + 1) % face.length], face[(at + face.length - 1) % face.length]]) {
          const seen = byNeighbour.get(other);
          if (seen === undefined) byNeighbour.set(other, i);
          else part[find(i)] = find(seen);
        }
      });
      const byPart = new Map<number, Copy>();
      list.forEach((f, i) => {
        let copy = byPart.get(find(i));
        if (!copy) {
          copy = { index: positions.length / 3, origin: v, faces: [] };
          positions.push(...position(mesh, v));
          byPart.set(find(i), copy);
          copies.push(copy);
        }
        copy.faces.push(f);
        copyOf.set(`${f}:${v}`, copy.index);
      });
    }

    const boundary: Region['boundary'] = [];
    for (const f of group) {
      const face = mesh.faces[f];
      faces[f] = face.map((v) => copyOf.get(`${f}:${v}`)!);
      face.forEach((a, i) => {
        const b = face[(i + 1) % face.length];
        if (uses.get(edgeKey(a, b)) === 1) boundary.push({ a, b, face: f, copyA: faces[f][i], copyB: faces[f][(i + 1) % face.length] });
      });
    }
    // The quad runs along the old edge (where the region's face used to be) and back along the new one.
    for (const { a, b, copyA, copyB } of boundary) faces.push([a, b, copyB, copyA]);
    return { copies, boundary };
  });
  return { positions, faces, regions };
}

function requireFaces(mesh: PolyMesh, faces: readonly number[], what: string): number[] {
  const list = [...new Set(faces)];
  if (list.length === 0) throw new Error(`Select at least one face to ${what}`);
  for (const f of list) if (!mesh.faces[f]) throw new Error(`Face ${f} does not exist`);
  return list;
}

function move(positions: number[], v: number, by: Vec3): void {
  positions[v * 3] += by[0];
  positions[v * 3 + 1] += by[1];
  positions[v * 3 + 2] += by[2];
}

/** Drops the vertices the region left behind; the face indices stay as they are. */
function finish(positions: number[], faces: number[][], selected: number[]): MeshOpResult {
  return { mesh: dropUnused({ positions, faces }).mesh, faces: selected };
}

/**
 * Region extrude: moves the faces by `distance` along the average of their normals and connects
 * them to the rest of the mesh with side faces. Selects the moved faces.
 */
export function extrudeFaces(mesh: PolyMesh, faces: readonly number[], distance: number): MeshOpResult {
  const list = requireFaces(mesh, faces, 'extrude');
  let sum: Vec3 = [0, 0, 0];
  for (const f of list) sum = add(sum, faceNormal(mesh, mesh.faces[f]));
  if (length(sum) < 1e-6 * list.length) {
    throw new Error('The selected faces point in opposite directions, so they have no common normal to extrude along. Select faces on one side only.');
  }
  const offset = scale(normalize(sum), distance);
  const { positions, faces: out, regions } = duplicateRegions(mesh, [list]);
  for (const copy of regions[0].copies) move(positions, copy.index, offset);
  return finish(positions, out, list);
}

/**
 * Inset: shrinks the faces inside their own outline by `thickness` (measured perpendicular to the
 * outline edges) and moves them by `depth` along their normal; a ring of quads fills the gap.
 * `individual` insets every face on its own instead of the selection as one region.
 * Selects the inner faces.
 */
export function insetFaces(mesh: PolyMesh, faces: readonly number[], thickness: number, depth: number, individual: boolean): MeshOpResult {
  const list = requireFaces(mesh, faces, 'inset');
  const { positions, faces: out, regions } = duplicateRegions(mesh, individual ? list.map((f) => [f]) : [list]);
  for (const region of regions) {
    // Per copied vertex: the summed inward directions of the outline edges that end in it.
    const inward = new Map<number, { sum: Vec3; edges: number }>();
    for (const { a, b, face, copyA, copyB } of region.boundary) {
      // The interior of a counter-clockwise face is to the left of its edges.
      const dir = normalize(cross(faceNormal(mesh, mesh.faces[face]), sub(position(mesh, b), position(mesh, a))));
      for (const copy of [copyA, copyB]) {
        const entry = inward.get(copy) ?? { sum: [0, 0, 0] as Vec3, edges: 0 };
        inward.set(copy, { sum: add(entry.sum, dir), edges: entry.edges + 1 });
      }
    }
    for (const copy of region.copies) {
      const normal = normalize(copy.faces.map((f) => faceNormal(mesh, mesh.faces[f])).reduce(add));
      move(positions, copy.index, scale(normal, depth));
      const entry = inward.get(copy.index);
      if (!entry) continue; // inside the region: only moves by depth
      // The offset o with o . dir = thickness on average over the outline edges at this vertex
      // (exactly, for the usual two edges): the mitre of the corner.
      const squared = dot(entry.sum, entry.sum);
      if (squared > 1e-12) move(positions, copy.index, scale(entry.sum, (thickness * entry.edges) / squared));
    }
  }
  return finish(positions, out, list);
}
