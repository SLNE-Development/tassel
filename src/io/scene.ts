// What every exporter starts from: the visible objects with their evaluated meshes.
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { defaultMaterial } from '../core/materials';
import { newell, triangulate } from '../core/mesh/polymesh';
import { evaluateObject } from '../core/modifiers/evaluate';
import type { DocState, Material, PolyMesh, Transform } from '../core/types';

export interface ExportItem {
  id: string;
  name: string;
  /** The mesh after modifiers, in the object's local space. */
  mesh: PolyMesh;
  smooth: boolean;
  transform: Transform;
  /** The object's material, or `fallbackMaterial` if it has none. */
  material: Material;
  groupId: string | null;
}

/** Stands in for "no material": the editor's default clay look. */
export const fallbackMaterial: Material = { id: '', name: 'Default', ...defaultMaterial };

/** The visible objects (limited to `ids` if given) that have geometry, in outliner order. */
export function collectItems(state: DocState, ids?: readonly string[]): ExportItem[] {
  const only = ids ? new Set(ids) : null;
  const items: ExportItem[] = [];
  for (const id of state.order) {
    const obj = state.objects[id];
    if (!obj || !obj.visible || (only && !only.has(id))) continue;
    const mesh = evaluateObject(state, id).mesh;
    if (mesh.faces.length === 0) continue;
    const material = (obj.materialId !== null && state.materials[obj.materialId]) || fallbackMaterial;
    items.push({ id, name: obj.name, mesh, smooth: obj.smooth, transform: obj.transform, material, groupId: obj.groupId });
  }
  return items;
}

export function transformQuaternion(t: Transform): Quaternion {
  const [x, y, z] = t.rotation.map(MathUtils.degToRad);
  return new Quaternion().setFromEuler(new Euler(x, y, z, 'XYZ'));
}

export function transformMatrix(t: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...t.position), transformQuaternion(t), new Vector3(...t.scale));
}

/**
 * The mesh with `matrix` applied to its vertices. A mirroring matrix (negative determinant) turns
 * faces inside out, so their winding is reversed to keep them facing outwards.
 */
export function bakeMesh(mesh: PolyMesh, matrix: Matrix4): PolyMesh {
  const e = matrix.elements;
  const p = mesh.positions;
  const positions = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    positions[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    positions[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    positions[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  if (matrix.determinant() >= 0) return mesh.uvs ? { positions, faces: mesh.faces, uvs: mesh.uvs } : { positions, faces: mesh.faces };
  // Keep the first corner, reverse the rest.
  const faces = mesh.faces.map((face) => [face[0], ...face.slice(1).reverse()]);
  const uvs = mesh.uvs?.map((uv) => {
    const out = [uv[0], uv[1]];
    for (let c = uv.length / 2 - 1; c >= 1; c--) out.push(uv[c * 2], uv[c * 2 + 1]);
    return out;
  });
  return uvs ? { positions, faces, uvs } : { positions, faces };
}

/** The item's mesh in world space. */
export function worldMesh(item: ExportItem): PolyMesh {
  return bakeMesh(item.mesh, transformMatrix(item.transform));
}

/** Unit vertex normals, area weighted (the same normals `triangulate(mesh, true)` uses). */
export function vertexNormals(mesh: PolyMesh): Float64Array {
  const normals = new Float64Array(mesh.positions.length);
  for (const face of mesh.faces) {
    const n = newell(mesh.positions, face);
    for (const v of face) {
      normals[v * 3] += n[0];
      normals[v * 3 + 1] += n[1];
      normals[v * 3 + 2] += n[2];
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

export interface IndexedTriangles {
  /** xyz per vertex. */
  positions: Float32Array;
  normals: Float32Array;
  /** uv per vertex (v up), if the mesh has UVs. */
  uvs?: Float32Array;
  indices: Uint32Array;
}

/**
 * Triangulates a mesh and merges corners that agree in position, normal and UV, which is how
 * formats with per-vertex attributes (glTF, PLY) want their data.
 */
export function indexedTriangles(mesh: PolyMesh, smooth: boolean): IndexedTriangles {
  const soup = triangulate(mesh, smooth);
  const corners = soup.positions.length / 3;
  const stride = soup.uvs ? 8 : 6;
  const data = new Float32Array(corners * stride);
  for (let c = 0; c < corners; c++) {
    data.set(soup.positions.subarray(c * 3, c * 3 + 3), c * stride);
    data.set(soup.normals.subarray(c * 3, c * 3 + 3), c * stride + 3);
    if (soup.uvs) data.set(soup.uvs.subarray(c * 2, c * 2 + 2), c * stride + 6);
  }
  // Compare bit patterns, so that 0 and -0 or NaNs cannot merge what is not identical.
  const bits = new Uint32Array(data.buffer);
  const seen = new Map<string, number>();
  const indices = new Uint32Array(corners);
  const order: number[] = [];
  for (let c = 0; c < corners; c++) {
    const key = bits.subarray(c * stride, (c + 1) * stride).join(',');
    let index = seen.get(key);
    if (index === undefined) {
      index = order.length;
      seen.set(key, index);
      order.push(c);
    }
    indices[c] = index;
  }
  const positions = new Float32Array(order.length * 3);
  const normals = new Float32Array(order.length * 3);
  const uvs = soup.uvs ? new Float32Array(order.length * 2) : undefined;
  order.forEach((c, i) => {
    positions.set(soup.positions.subarray(c * 3, c * 3 + 3), i * 3);
    normals.set(soup.normals.subarray(c * 3, c * 3 + 3), i * 3);
    uvs?.set(soup.uvs!.subarray(c * 2, c * 2 + 2), i * 2);
  });
  return uvs ? { positions, normals, uvs, indices } : { positions, normals, indices };
}

/** "#rrggbb" → sRGB components 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** sRGB components 0..1 → "#rrggbb" (clamped). */
export function rgbToHex(rgb: readonly number[]): string {
  const byte = (c: number) => Math.round(Math.min(1, Math.max(0, Number.isFinite(c) ? c : 0)) * 255);
  return `#${[0, 1, 2].map((i) => byte(rgb[i]).toString(16).padStart(2, '0')).join('')}`;
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
