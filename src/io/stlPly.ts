// Binary STL and PLY writers. Both formats hold one mesh without transforms, so everything is written
// in world space, triangulated.
import { triangulate } from '../core/mesh/polymesh';
import { indexedTriangles, worldMesh, type ExportItem } from './scene';

/** Binary STL: 80 byte header, triangle count, then normal + 3 vertices + 2 unused bytes per triangle. */
export function writeStl(items: readonly ExportItem[]): Uint8Array<ArrayBuffer> {
  const soups = items.map((item) => triangulate(worldMesh(item), false));
  const count = soups.reduce((sum, soup) => sum + soup.triToFace.length, 0);
  const out = new Uint8Array(84 + count * 50);
  out.set(new TextEncoder().encode('Tessel binary STL, Y up, meters'));
  const view = new DataView(out.buffer);
  view.setUint32(80, count, true);
  let at = 84;
  for (const soup of soups) {
    for (let t = 0; t < soup.triToFace.length; t++) {
      // Flat normals: the three corners of a triangle carry the same one.
      for (let i = 0; i < 3; i++) view.setFloat32(at + i * 4, soup.normals[t * 9 + i], true);
      for (let i = 0; i < 9; i++) view.setFloat32(at + 12 + i * 4, soup.positions[t * 9 + i], true);
      at += 50;
    }
  }
  return out;
}

/**
 * Binary little-endian PLY with per-vertex normals and, if any object has UVs, texture coordinates
 * (properties s and t, v up; objects without UVs get 0 0). Vertices are split where normals or UVs differ.
 */
export function writePly(items: readonly ExportItem[]): Uint8Array<ArrayBuffer> {
  const meshes = items.map((item) => indexedTriangles(worldMesh(item), item.smooth));
  const withUvs = meshes.some((m) => m.uvs);
  const vertexCount = meshes.reduce((sum, m) => sum + m.positions.length / 3, 0);
  const faceCount = meshes.reduce((sum, m) => sum + m.indices.length / 3, 0);
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Tessel PLY export, Y up, meters',
    `element vertex ${vertexCount}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    ...(withUvs ? ['property float s', 'property float t'] : []),
    `element face ${faceCount}`,
    'property list uchar uint vertex_indices',
    'end_header',
    '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const stride = withUvs ? 32 : 24;
  const out = new Uint8Array(headerBytes.length + vertexCount * stride + faceCount * 13);
  out.set(headerBytes);
  const view = new DataView(out.buffer);
  let at = headerBytes.length;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length / 3; i++) {
      for (let k = 0; k < 3; k++) view.setFloat32(at + k * 4, m.positions[i * 3 + k], true);
      for (let k = 0; k < 3; k++) view.setFloat32(at + 12 + k * 4, m.normals[i * 3 + k], true);
      if (withUvs && m.uvs) {
        view.setFloat32(at + 24, m.uvs[i * 2], true);
        view.setFloat32(at + 28, m.uvs[i * 2 + 1], true);
      }
      at += stride;
    }
  }
  let base = 0;
  for (const m of meshes) {
    for (let i = 0; i < m.indices.length; i += 3) {
      view.setUint8(at, 3);
      for (let k = 0; k < 3; k++) view.setUint32(at + 1 + k * 4, base + m.indices[i + k], true);
      at += 13;
    }
    base += m.positions.length / 3;
  }
  return out;
}
