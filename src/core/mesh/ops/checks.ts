// Mesh sanity checks, used by the tests of the mesh operations.
import type { PolyMesh } from '../../types';
import { faceArea, vertexCount } from './util';

/**
 * Lists what is wrong with a mesh (empty = fine): invalid indices, degenerate faces (fewer than three
 * vertices, a repeated vertex, no area), duplicate faces and unused vertices. With `closed` also
 * everything that keeps it from being a closed manifold with consistent winding: every edge must be
 * used by exactly two faces, in opposite directions.
 */
export function meshProblems(mesh: PolyMesh, closed = true): string[] {
  const problems: string[] = [];
  const count = vertexCount(mesh);
  if (!Number.isInteger(count)) return ['positions length is not a multiple of 3'];
  if (!mesh.positions.every(Number.isFinite)) problems.push('non-finite position');

  const used = new Set<number>();
  const cycles = new Set<string>();
  const directed = new Map<string, number>();
  mesh.faces.forEach((face, f) => {
    if (face.some((v) => !Number.isInteger(v) || v < 0 || v >= count)) {
      problems.push(`face ${f} has an invalid vertex index`);
      return;
    }
    if (face.length < 3) problems.push(`face ${f} has fewer than three vertices`);
    if (new Set(face).size !== face.length) problems.push(`face ${f} repeats a vertex`);
    else if (!(faceArea(mesh, face) > 1e-12)) problems.push(`face ${f} has no area`);
    const key = [...face].sort((a, b) => a - b).join(',');
    if (cycles.has(key)) problems.push(`face ${f} duplicates another face`);
    cycles.add(key);
    face.forEach((a, i) => {
      used.add(a);
      const edge = `${a}>${face[(i + 1) % face.length]}`;
      directed.set(edge, (directed.get(edge) ?? 0) + 1);
    });
  });
  if (used.size !== count) problems.push(`${count - used.size} unused vertices`);

  if (closed) {
    for (const [edge, uses] of directed) {
      const [a, b] = edge.split('>');
      if (uses !== 1) problems.push(`edge ${edge} is used ${uses} times in the same direction`);
      if (directed.get(`${b}>${a}`) !== 1) problems.push(`edge ${edge} has no single opposite`);
    }
  }
  return problems;
}
