// Pure helpers for element selections in edit mode.
import type { Edge, EditState, ElementMode, PolyMesh, Vec3 } from '../types';
import { faceArea, faceCentroid, vertexCount } from './ops/util';
import { edges as meshEdges, faceNormal } from './polymesh';
import { edgeKey, makeEdge } from './topology';

/** An element selection: only the array matching `elementMode` is populated. `EditState` is one. */
export type MeshSelection = Pick<EditState, 'elementMode' | 'vertices' | 'edges' | 'faces'>;

export type SelectAction = 'replace' | 'add' | 'remove' | 'toggle';

export function makeSelection(mode: ElementMode, elements: readonly number[] | readonly Edge[]): MeshSelection {
  return {
    elementMode: mode,
    vertices: mode === 'vertex' ? (elements as readonly number[]) : [],
    edges: mode === 'edge' ? (elements as readonly Edge[]) : [],
    faces: mode === 'face' ? (elements as readonly number[]) : [],
  };
}

function unique(values: Iterable<number>): number[] {
  return [...new Set(values)];
}

/** The vertices of the selected elements, in selection order. */
export function selectedVertices(mesh: PolyMesh, sel: MeshSelection): number[] {
  if (sel.elementMode === 'vertex') return [...sel.vertices];
  if (sel.elementMode === 'edge') return unique(sel.edges.flat());
  return unique(sel.faces.flatMap((f) => mesh.faces[f]));
}

function edgesOfVertices(mesh: PolyMesh, vertices: readonly number[]): Edge[] {
  const set = new Set(vertices);
  return meshEdges(mesh).filter(([a, b]) => set.has(a) && set.has(b));
}

function facesOfVertices(mesh: PolyMesh, vertices: readonly number[]): number[] {
  const set = new Set(vertices);
  const out: number[] = [];
  mesh.faces.forEach((face, fi) => {
    if (face.every((v) => set.has(v))) out.push(fi);
  });
  return out;
}

/** The selection as edges: the selected edges, or every edge whose two vertices are selected. */
export function selectedEdges(mesh: PolyMesh, sel: MeshSelection): Edge[] {
  return sel.elementMode === 'edge' ? [...sel.edges] : edgesOfVertices(mesh, selectedVertices(mesh, sel));
}

/** The selection as faces: the selected faces, or every face whose vertices are all selected. */
export function selectedFaces(mesh: PolyMesh, sel: MeshSelection): number[] {
  return sel.elementMode === 'face' ? [...sel.faces] : facesOfVertices(mesh, selectedVertices(mesh, sel));
}

/** Converts a selection to another element kind (via the vertices of the selected elements). */
export function convertSelection(mesh: PolyMesh, sel: MeshSelection, mode: ElementMode): MeshSelection {
  if (mode === sel.elementMode) return sel;
  if (mode === 'vertex') return makeSelection(mode, selectedVertices(mesh, sel));
  if (mode === 'edge') return makeSelection(mode, selectedEdges(mesh, sel));
  return makeSelection(mode, selectedFaces(mesh, sel));
}

/** Selection in `mode` from what a mesh operation returned (whichever element kind it gave). */
export function selectionFromElements(
  mesh: PolyMesh,
  mode: ElementMode,
  elements: { vertices?: readonly number[]; edges?: readonly Edge[]; faces?: readonly number[] },
): MeshSelection {
  const own = mode === 'vertex' ? elements.vertices : mode === 'edge' ? elements.edges : elements.faces;
  if (own) return makeSelection(mode, own);
  const given: MeshSelection = elements.faces
    ? makeSelection('face', elements.faces)
    : elements.edges
      ? makeSelection('edge', elements.edges)
      : makeSelection('vertex', elements.vertices ?? []);
  return convertSelection(mesh, given, mode);
}

/** Applies replace / add / remove / toggle to a selection of the same element kind. Keeps selection order. */
export function combineSelection(
  current: MeshSelection,
  elements: readonly number[] | readonly Edge[],
  action: SelectAction,
): MeshSelection {
  const mode = current.elementMode;
  const key = (e: number | Edge) => (typeof e === 'number' ? String(e) : edgeKey(e[0], e[1]));
  const before: readonly (number | Edge)[] = mode === 'vertex' ? current.vertices : mode === 'edge' ? current.edges : current.faces;
  const result = new Map<string, number | Edge>();
  if (action !== 'replace') for (const e of before) result.set(key(e), e);
  for (const e of elements) {
    const k = key(e);
    if (action === 'remove' || (action === 'toggle' && result.has(k))) result.delete(k);
    else result.set(k, e);
  }
  return makeSelection(mode, [...result.values()] as number[] | Edge[]);
}

export function selectAll(mesh: PolyMesh, mode: ElementMode): MeshSelection {
  if (mode === 'vertex') return makeSelection(mode, Array.from({ length: vertexCount(mesh) }, (_, i) => i));
  if (mode === 'edge') return makeSelection(mode, meshEdges(mesh));
  return makeSelection(mode, mesh.faces.map((_, i) => i));
}

export function invertSelection(mesh: PolyMesh, sel: MeshSelection): MeshSelection {
  const all = selectAll(mesh, sel.elementMode);
  if (sel.elementMode === 'edge') {
    const selected = new Set(sel.edges.map(([a, b]) => edgeKey(a, b)));
    return makeSelection('edge', all.edges.filter(([a, b]) => !selected.has(edgeKey(a, b))));
  }
  const selected = new Set(sel.elementMode === 'vertex' ? sel.vertices : sel.faces);
  const list = sel.elementMode === 'vertex' ? all.vertices : all.faces;
  return makeSelection(sel.elementMode, list.filter((i) => !selected.has(i)));
}

/** Everything that is connected (through faces) to the selection. */
export function selectLinked(mesh: PolyMesh, sel: MeshSelection): MeshSelection {
  // Union-find over vertices; every face joins its vertices.
  const parent = Int32Array.from({ length: vertexCount(mesh) }, (_, i) => i);
  const find = (v: number): number => {
    while (parent[v] !== v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (const face of mesh.faces) for (const v of face) parent[find(v)] = find(face[0]);
  const roots = new Set(selectedVertices(mesh, sel).map(find));
  const vertices: number[] = [];
  for (let v = 0; v < parent.length; v++) if (roots.has(find(v))) vertices.push(v);
  return convertSelection(mesh, makeSelection('vertex', vertices), sel.elementMode);
}

/** Grows the selection by one ring: all elements of faces that touch a selected vertex. */
export function selectMore(mesh: PolyMesh, sel: MeshSelection): MeshSelection {
  const selected = new Set(selectedVertices(mesh, sel));
  const grown = new Set(selected);
  for (const face of mesh.faces) {
    if (face.some((v) => selected.has(v))) for (const v of face) grown.add(v);
  }
  const vertices = [...grown].sort((a, b) => a - b);
  return convertSelection(mesh, makeSelection('vertex', vertices), sel.elementMode);
}

/** Shrinks the selection by one ring: drops everything that touches a face which is not fully selected. */
export function selectLess(mesh: PolyMesh, sel: MeshSelection): MeshSelection {
  const selected = new Set(selectedVertices(mesh, sel));
  const kept = new Set(selected);
  for (const face of mesh.faces) {
    if (!face.every((v) => selected.has(v))) for (const v of face) kept.delete(v);
  }
  const vertices = [...kept].sort((a, b) => a - b);
  return convertSelection(mesh, makeSelection('vertex', vertices), sel.elementMode);
}

export interface SelectCriteria {
  /** Direction (any length) that face normals are compared against. */
  normal?: Vec3;
  /** Maximum angle in degrees between a face normal and `normal`. */
  angle?: number;
  boxMin?: Vec3;
  boxMax?: Vec3;
}

function inBox(p: Vec3, min: Vec3 | undefined, max: Vec3 | undefined): boolean {
  const eps = 1e-9;
  for (let a = 0; a < 3; a++) {
    if (min && p[a] < min[a] - eps) return false;
    if (max && p[a] > max[a] + eps) return false;
  }
  return true;
}

const midpoint = (mesh: PolyMesh, [a, b]: Edge): Vec3 => faceCentroid(mesh, [a, b]);

/**
 * Elements of kind `mode` that match all given criteria. Normal: faces whose normal is within `angle`
 * degrees of `normal` (vertex / edge mode: the vertices / edges of those faces). Box: the element
 * centre (vertex position, edge midpoint, face centroid) lies inside [boxMin, boxMax].
 */
export function selectBy(mesh: PolyMesh, mode: ElementMode, criteria: SelectCriteria): MeshSelection {
  const { normal, angle = 10, boxMin, boxMax } = criteria;
  let facing: boolean[] | null = null;
  if (normal) {
    const len = Math.hypot(...normal);
    if (len === 0) throw new Error('normal must not be the zero vector');
    // A hair of tolerance so that "exactly 90 degrees" style queries are not lost to rounding.
    const limit = Math.cos((Math.min(angle, 180) * Math.PI) / 180) - 1e-9;
    facing = mesh.faces.map((face) => {
      const n = faceNormal(mesh, face);
      return (n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2]) / len >= limit;
    });
  }

  if (mode === 'face') {
    const faces: number[] = [];
    mesh.faces.forEach((face, fi) => {
      if ((!facing || facing[fi]) && inBox(faceCentroid(mesh, face), boxMin, boxMax)) faces.push(fi);
    });
    return makeSelection(mode, faces);
  }
  if (mode === 'vertex') {
    const allowed = facing ? new Set(mesh.faces.flatMap((face, fi) => (facing[fi] ? face : []))) : null;
    const vertices: number[] = [];
    for (let v = 0; v < vertexCount(mesh); v++) {
      if ((!allowed || allowed.has(v)) && inBox(faceCentroid(mesh, [v]), boxMin, boxMax)) vertices.push(v);
    }
    return makeSelection(mode, vertices);
  }
  let allowed: Set<string> | null = null;
  if (facing) {
    allowed = new Set();
    mesh.faces.forEach((face, fi) => {
      if (facing[fi]) face.forEach((a, i) => allowed!.add(edgeKey(a, face[(i + 1) % face.length])));
    });
  }
  return makeSelection(
    mode,
    meshEdges(mesh).filter((e) => (!allowed || allowed.has(edgeKey(e[0], e[1]))) && inBox(midpoint(mesh, e), boxMin, boxMax)),
  );
}

export type ElementInfo =
  | { index: number; position: Vec3; selected: boolean }
  | { vertices: [number, number]; midpoint: Vec3; length: number; selected: boolean }
  | { index: number; vertices: number[]; centroid: Vec3; normal: Vec3; area: number; selected: boolean };

/** Describes elements `offset .. offset + limit` of one kind. `total` counts all that match. */
export function listElements(
  mesh: PolyMesh,
  kind: ElementMode,
  sel: MeshSelection,
  opts: { selectedOnly: boolean; offset: number; limit: number },
): { total: number; elements: ElementInfo[] } {
  const own = convertSelection(mesh, sel, kind);
  const page = <T>(list: T[]) => list.slice(opts.offset, opts.offset + opts.limit);

  if (kind === 'vertex') {
    const selected = new Set(own.vertices);
    let list = selectAll(mesh, kind).vertices as number[];
    if (opts.selectedOnly) list = list.filter((v) => selected.has(v));
    return {
      total: list.length,
      elements: page(list).map((v) => ({ index: v, position: faceCentroid(mesh, [v]), selected: selected.has(v) })),
    };
  }
  if (kind === 'edge') {
    const selected = new Set(own.edges.map(([a, b]) => edgeKey(a, b)));
    let list = meshEdges(mesh);
    if (opts.selectedOnly) list = list.filter(([a, b]) => selected.has(edgeKey(a, b)));
    return {
      total: list.length,
      elements: page(list).map(([a, b]) => ({
        vertices: [a, b],
        midpoint: midpoint(mesh, [a, b]),
        length: Math.hypot(
          mesh.positions[a * 3] - mesh.positions[b * 3],
          mesh.positions[a * 3 + 1] - mesh.positions[b * 3 + 1],
          mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2],
        ),
        selected: selected.has(edgeKey(a, b)),
      })),
    };
  }
  const selected = new Set(own.faces);
  let list = mesh.faces.map((_, i) => i);
  if (opts.selectedOnly) list = list.filter((f) => selected.has(f));
  return {
    total: list.length,
    elements: page(list).map((f) => ({
      index: f,
      vertices: [...mesh.faces[f]],
      centroid: faceCentroid(mesh, mesh.faces[f]),
      normal: faceNormal(mesh, mesh.faces[f]),
      area: faceArea(mesh, mesh.faces[f]),
      selected: selected.has(f),
    })),
  };
}

/** Throws a clear error if the elements do not exist in the mesh. Returns edges normalized to a < b. */
export function checkElements(mesh: PolyMesh, mode: ElementMode, elements: readonly number[] | readonly Edge[]): number[] | Edge[] {
  if (mode === 'edge') {
    const existing = new Set(meshEdges(mesh).map(([a, b]) => edgeKey(a, b)));
    return (elements as readonly Edge[]).map(([a, b]) => {
      if (!existing.has(edgeKey(a, b))) throw new Error(`The mesh has no edge between vertices ${a} and ${b}`);
      return makeEdge(a, b);
    });
  }
  const count = mode === 'vertex' ? vertexCount(mesh) : mesh.faces.length;
  for (const i of elements as readonly number[]) {
    if (i >= count) throw new Error(`${mode === 'vertex' ? 'Vertex' : 'Face'} ${i} does not exist (the mesh has ${count})`);
  }
  return [...(elements as readonly number[])];
}
