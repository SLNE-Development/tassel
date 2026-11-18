import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { faceNormal, triangulate, wireframePositions } from '../core/mesh/polymesh';
import type { PolyMesh } from '../core/types';

/** GPU geometry of one PolyMesh. Edge geometries are built on first use. */
export class MeshGeometry {
  readonly solid: BufferGeometry;
  refs = 0;
  private edgePositions: Float32Array | null = null;
  private wireGeometry: BufferGeometry | null = null;
  private outlineGeometry: LineSegmentsGeometry | null | undefined;

  constructor(private readonly mesh: PolyMesh) {
    const soup = triangulate(mesh);
    this.solid = new BufferGeometry();
    this.solid.setAttribute('position', new BufferAttribute(soup.positions, 3));
    this.solid.setAttribute('normal', new BufferAttribute(soup.normals, 3));
    this.solid.computeBoundingBox();
    this.solid.computeBoundingSphere();
  }

  private edges(): Float32Array {
    return (this.edgePositions ??= wireframePositions(this.mesh));
  }

  /** Thin edge lines for wireframe shading. */
  get wire(): BufferGeometry {
    if (!this.wireGeometry) {
      this.wireGeometry = new BufferGeometry();
      this.wireGeometry.setAttribute('position', new BufferAttribute(this.edges(), 3));
    }
    return this.wireGeometry;
  }

  /**
   * Wide lines along the feature edges (borders and sharp creases) for the selection highlight,
   * or null for a mesh without such edges, e.g. a sphere.
   */
  get outline(): LineSegmentsGeometry | null {
    if (this.outlineGeometry === undefined) {
      const positions = featureEdgePositions(this.mesh);
      this.outlineGeometry = positions.length > 0 ? new LineSegmentsGeometry().setPositions(positions) : null;
    }
    return this.outlineGeometry;
  }

  dispose(): void {
    this.solid.dispose();
    this.wireGeometry?.dispose();
    this.outlineGeometry?.dispose();
  }
}

/** Faces meeting at a sharper angle than this form a feature edge. */
const CREASE_COS = Math.cos((40 * Math.PI) / 180);

/** Line segments (6 floats each) of all edges that are open, non-manifold or creased. */
export function featureEdgePositions(mesh: PolyMesh): Float32Array {
  const p = mesh.positions;
  const vertexCount = p.length / 3;
  // Per edge: number of adjacent faces, the first face's normal and whether a crease was found.
  const edges = new Map<number, { a: number; b: number; faces: number; normal: readonly number[]; crease: boolean }>();
  for (const face of mesh.faces) {
    const normal = faceNormal(mesh, face);
    for (let i = 0; i < face.length; i++) {
      const a = Math.min(face[i], face[(i + 1) % face.length]);
      const b = Math.max(face[i], face[(i + 1) % face.length]);
      const key = a * vertexCount + b;
      const edge = edges.get(key);
      if (!edge) {
        edges.set(key, { a, b, faces: 1, normal, crease: false });
      } else {
        edge.faces++;
        const dot = edge.normal[0] * normal[0] + edge.normal[1] * normal[1] + edge.normal[2] * normal[2];
        if (dot < CREASE_COS) edge.crease = true;
      }
    }
  }
  const out: number[] = [];
  for (const { a, b, faces, crease } of edges.values()) {
    if (faces === 2 && !crease) continue;
    out.push(p[a * 3], p[a * 3 + 1], p[a * 3 + 2], p[b * 3], p[b * 3 + 1], p[b * 3 + 2]);
  }
  return new Float32Array(out);
}

/**
 * Reference-counted cache from PolyMesh to GPU geometry. Meshes are immutable and keep their
 * identity while unchanged, so geometry is only built when a mesh really is new, and objects
 * that share a mesh (duplicates) share its buffers.
 */
export class GeometryStore {
  private readonly cache = new Map<PolyMesh, MeshGeometry>();

  acquire(mesh: PolyMesh): MeshGeometry {
    let geometry = this.cache.get(mesh);
    if (!geometry) {
      geometry = new MeshGeometry(mesh);
      this.cache.set(mesh, geometry);
    }
    geometry.refs++;
    return geometry;
  }

  release(mesh: PolyMesh): void {
    const geometry = this.cache.get(mesh);
    if (!geometry || --geometry.refs > 0) return;
    geometry.dispose();
    this.cache.delete(mesh);
  }

  dispose(): void {
    this.cache.forEach((g) => g.dispose());
    this.cache.clear();
  }
}
