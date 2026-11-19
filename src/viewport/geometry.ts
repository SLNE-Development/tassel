import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { faceNormal, triangulate, wireframePositions } from '../core/mesh/polymesh';
import type { PolyMesh } from '../core/types';

/** GPU geometry of one PolyMesh with flat or smooth normals. Edge geometries are built on first use. */
export class MeshGeometry {
  readonly solid: BufferGeometry;
  refs = 0;
  private edgePositions: Float32Array | null = null;
  private wireGeometry: BufferGeometry | null = null;
  private outlineGeometry: LineSegmentsGeometry | null | undefined;
  private featurePositions: Float32Array | null = null;
  private creaseGeometry: BufferGeometry | null | undefined;

  constructor(
    readonly mesh: PolyMesh,
    readonly smooth: boolean,
  ) {
    const soup = triangulate(mesh, smooth);
    this.solid = new BufferGeometry();
    this.solid.setAttribute('position', new BufferAttribute(soup.positions, 3));
    this.solid.setAttribute('normal', new BufferAttribute(soup.normals, 3));
    if (soup.uvs) this.solid.setAttribute('uv', new BufferAttribute(soup.uvs, 2));
    this.solid.computeBoundingBox();
    this.solid.computeBoundingSphere();
  }

  /** Whether the mesh is unwrapped, i.e. `solid` has a `uv` attribute and can show texture maps. */
  get hasUvs(): boolean {
    return this.solid.hasAttribute('uv');
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
      const positions = this.features();
      this.outlineGeometry = positions.length > 0 ? new LineSegmentsGeometry().setPositions(positions) : null;
    }
    return this.outlineGeometry;
  }

  private features(): Float32Array {
    return (this.featurePositions ??= featureEdgePositions(this.mesh));
  }

  /** The feature edges as thin lines (x-ray screenshots), or null for a mesh without such edges. */
  get creases(): BufferGeometry | null {
    if (this.creaseGeometry === undefined) {
      const positions = this.features();
      this.creaseGeometry = positions.length > 0 ? new BufferGeometry().setAttribute('position', new BufferAttribute(positions, 3)) : null;
    }
    return this.creaseGeometry;
  }

  dispose(): void {
    this.solid.dispose();
    this.creaseGeometry?.dispose();
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
 * Reference-counted cache from (PolyMesh, smooth) to GPU geometry. Meshes are immutable and keep
 * their identity while unchanged, so geometry is only built when a mesh really is new, and objects
 * that share a mesh (duplicates) share its buffers.
 */
export class GeometryStore {
  /** [flat, smooth] */
  private readonly caches = [new Map<PolyMesh, MeshGeometry>(), new Map<PolyMesh, MeshGeometry>()];

  acquire(mesh: PolyMesh, smooth: boolean): MeshGeometry {
    const cache = this.caches[smooth ? 1 : 0];
    let geometry = cache.get(mesh);
    if (!geometry) {
      geometry = new MeshGeometry(mesh, smooth);
      cache.set(mesh, geometry);
    }
    geometry.refs++;
    return geometry;
  }

  release(geometry: MeshGeometry): void {
    if (--geometry.refs > 0) return;
    geometry.dispose();
    this.caches[geometry.smooth ? 1 : 0].delete(geometry.mesh);
  }

  dispose(): void {
    for (const cache of this.caches) {
      cache.forEach((g) => g.dispose());
      cache.clear();
    }
  }
}
