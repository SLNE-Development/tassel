import { edgeKey } from '../mesh/topology';
import type { PolyMesh } from '../types';

interface EdgeInfo {
  a: number;
  b: number;
  faces: number[];
  /** Index of the edge point in the result. */
  point: number;
}

/**
 * One Catmull-Clark step for arbitrary polygons. Every face with n corners becomes n quads.
 * Boundary edges and vertices follow the cubic B-spline curve rules, so open borders keep their
 * outline; edges with more than two faces are treated like boundaries (creases).
 * Result vertices: the original ones (moved), then one per edge, then one per face.
 */
function catmullClarkStep(mesh: PolyMesh): PolyMesh {
  const src = mesh.positions;
  const vertexCount = src.length / 3;
  const edges = new Map<string, EdgeInfo>();
  mesh.faces.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i];
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const edge = edges.get(key);
      if (edge) edge.faces.push(fi);
      else edges.set(key, { a, b, faces: [fi], point: vertexCount + edges.size });
    }
  });
  const faceOffset = vertexCount + edges.size;
  const out = new Array<number>((faceOffset + mesh.faces.length) * 3).fill(0);

  // Face points: centroids.
  mesh.faces.forEach((face, fi) => {
    const o = (faceOffset + fi) * 3;
    for (const v of face) for (let k = 0; k < 3; k++) out[o + k] += src[v * 3 + k] / face.length;
  });

  // Edge points, and per vertex what its new position needs.
  const faceSum = new Float64Array(vertexCount * 3); // sum of adjacent face points
  const faceCount = new Uint32Array(vertexCount);
  const midSum = new Float64Array(vertexCount * 3); // sum of incident edge midpoints
  const edgeCount = new Uint32Array(vertexCount);
  const sharpSum = new Float64Array(vertexCount * 3); // sum of neighbours along boundary edges
  const sharpCount = new Uint32Array(vertexCount);
  mesh.faces.forEach((face, fi) => {
    for (const v of face) {
      for (let k = 0; k < 3; k++) faceSum[v * 3 + k] += out[(faceOffset + fi) * 3 + k];
      faceCount[v]++;
    }
  });
  for (const edge of edges.values()) {
    const { a, b, point } = edge;
    const smooth = edge.faces.length === 2;
    for (let k = 0; k < 3; k++) {
      const mid = (src[a * 3 + k] + src[b * 3 + k]) / 2;
      midSum[a * 3 + k] += mid;
      midSum[b * 3 + k] += mid;
      out[point * 3 + k] = smooth
        ? (mid * 2 + out[(faceOffset + edge.faces[0]) * 3 + k] + out[(faceOffset + edge.faces[1]) * 3 + k]) / 4
        : mid;
      if (!smooth) {
        sharpSum[a * 3 + k] += src[b * 3 + k];
        sharpSum[b * 3 + k] += src[a * 3 + k];
      }
    }
    edgeCount[a]++;
    edgeCount[b]++;
    if (!smooth) {
      sharpCount[a]++;
      sharpCount[b]++;
    }
  }

  // Vertex points.
  for (let v = 0; v < vertexCount; v++) {
    const n = edgeCount[v];
    for (let k = 0; k < 3; k++) {
      const p = src[v * 3 + k];
      if (sharpCount[v] === 2) out[v * 3 + k] = p * 0.75 + sharpSum[v * 3 + k] / 8;
      else if (sharpCount[v] > 0 || n === 0) out[v * 3 + k] = p; // corner, or not part of any face
      else out[v * 3 + k] = (faceSum[v * 3 + k] / faceCount[v] + (2 * midSum[v * 3 + k]) / n + (n - 3) * p) / n;
    }
  }

  const faces: number[][] = [];
  mesh.faces.forEach((face, fi) => {
    const n = face.length;
    for (let i = 0; i < n; i++) {
      const v = face[i];
      const next = edges.get(edgeKey(v, face[(i + 1) % n]))!.point;
      const prev = edges.get(edgeKey(face[(i + n - 1) % n], v))!.point;
      faces.push([v, next, faceOffset + fi, prev]);
    }
  });
  return { positions: out, faces };
}

export function subdivide(mesh: PolyMesh, levels: number): PolyMesh {
  let out = mesh;
  for (let i = 0; i < levels; i++) out = catmullClarkStep(out);
  return out;
}
