import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Line2NodeMaterial,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshBasicNodeMaterial,
  type Material,
} from 'three/webgpu';
import {
  attribute,
  cameraProjectionMatrix,
  float,
  max,
  mix,
  modelViewMatrix,
  positionGeometry,
  screenDPR,
  step,
  uniform,
  vec4,
  viewportSize,
} from 'three/tsl';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { triangulate } from '../core/mesh/polymesh';
import type { EditState, ElementMode, PolyMesh, Shading } from '../core/types';
import type { ViewportPalette } from './theme';

/** Materials shared by all edit views, so that a mesh edit never compiles a shader. */
export class EditMaterials {
  /** All edges for [solid, wireframe] shading. */
  readonly wire = [0, 1].map(() => new LineBasicMaterial({ fog: false }));
  readonly tint = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
  });
  /** Slightly in front of the thin edge lines it covers. */
  readonly highlight = new Line2NodeMaterial({
    linewidth: 3,
    worldUnits: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  /**
   * Vertices as instanced screen-sized squares (WebGPU has no sized point primitives): dark with a
   * light rim, so they show on the clay as well as against the background; `instanceSelected`
   * (0 or 1) makes them accent coloured and a little larger.
   */
  readonly points = new MeshBasicNodeMaterial({ fog: false });
  private readonly vertexColor = uniform(new Color());
  private readonly vertexRimColor = uniform(new Color());
  private readonly accentColor = uniform(new Color());

  constructor() {
    this.highlight.fog = false;
    const selected = attribute('instanceSelected', 'float');
    const corner = positionGeometry.xy;
    const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(attribute('instancePosition', 'vec3'), 1));
    const size = mix(float(6), float(8), selected).mul(screenDPR);
    const offset = corner.mul(size).div(viewportSize.div(2)).mul(clip.w);
    // Pulled towards the camera a little, so that the faces around a vertex do not cut into its square.
    this.points.vertexNode = vec4(clip.xy.add(offset), clip.z.sub(clip.w.mul(POINT_DEPTH_BIAS)), clip.w);
    const rim = step(0.34, max(corner.x.abs(), corner.y.abs()));
    const unselected = mix(this.vertexColor, this.vertexRimColor, rim);
    this.points.colorNode = mix(unselected, this.accentColor, selected);
  }

  /** Colours are uniforms and material properties, so a theme change compiles nothing. */
  setColors(palette: ViewportPalette, accent: string): void {
    this.wire[0].color.set(palette.editEdge);
    this.wire[1].color.set(palette.wire);
    this.tint.color.set(accent);
    this.highlight.color.set(accent);
    this.vertexColor.value.set(palette.editVertex);
    this.vertexRimColor.value.set(palette.editVertexRim);
    this.accentColor.value.set(accent);
  }

  dispose(): void {
    const all: Material[] = [...this.wire, this.tint, this.highlight, this.points];
    all.forEach((m) => m.dispose());
  }
}

/** Vertices used by the selection, whatever the element mode. */
export function selectedVertices(mesh: PolyMesh, edit: EditState): number[] {
  if (edit.elementMode === 'vertex') return [...edit.vertices];
  const set = new Set<number>();
  if (edit.elementMode === 'edge') for (const [a, b] of edit.edges) set.add(a).add(b);
  else for (const f of edit.faces) for (const v of mesh.faces[f] ?? []) set.add(v);
  return [...set];
}

/**
 * Everything that is drawn for the object in edit mode: its base mesh (flat), all edges, all
 * vertices and the selection highlight. The big buffers are built once per mesh; a selection
 * change only refills what depends on the selection, and a gizmo drag moves vertices directly in
 * the buffers (`beginPreview` / `preview`).
 */
export class EditView {
  /** Add this to the object's group. */
  readonly group = new Group();
  /** The faces; also the raycast target for face picking. */
  readonly solid: Mesh;
  /** Local-space bounds of the mesh (not updated by previews). */
  readonly box = new Box3();
  /** Current vertex positions, xyz per vertex (previewed positions during a drag). */
  readonly vertexPositions: Float32Array;
  /** Face index per triangle of `solid`. */
  readonly triToFace: Uint32Array;
  /** Vertex index per triangle corner of `solid`. */
  readonly cornerVertex: Uint32Array;
  /** Vertex index pairs of all unique edges. */
  readonly edgeVertices: Uint32Array;
  /** The EditState shown by `setSelection`, to skip redundant updates. */
  shown: EditState | null = null;

  private readonly solidGeometry = new BufferGeometry();
  private readonly wireGeometry = new BufferGeometry();
  private readonly tintGeometry = new BufferGeometry();
  private readonly pointGeometry = new InstancedBufferGeometry();
  private readonly wire: LineSegments;
  private readonly tint: Mesh;
  private readonly points: Mesh;
  private highlight: LineSegments2 | null = null;
  /** Vertex index per endpoint of the highlight lines. */
  private highlightVertices = new Uint32Array(0);
  /** Triangles of face f: faceTris[faceTriStart[f] .. faceTriStart[f + 1]]. */
  private readonly faceTriStart: Uint32Array;
  private readonly faceTris: Uint32Array;
  private readonly selectedFlags: Float32Array;
  private previewState: {
    vertices: Uint32Array;
    base: Float32Array;
    corners: Uint32Array;
    wireEnds: Uint32Array;
    faces: Uint32Array;
  } | null = null;

  constructor(
    readonly mesh: PolyMesh,
    private readonly materials: EditMaterials,
    clay: Material,
  ) {
    const soup = triangulate(mesh, false);
    const triCount = soup.triToFace.length;
    const vertexCount = mesh.positions.length / 3;
    this.triToFace = soup.triToFace;
    this.vertexPositions = new Float32Array(mesh.positions);
    this.selectedFlags = new Float32Array(vertexCount);

    // Which vertex each triangle corner came from: the vertex of its face at the same position.
    const vp = this.vertexPositions;
    this.cornerVertex = new Uint32Array(triCount * 3);
    for (let c = 0; c < triCount * 3; c++) {
      const face = mesh.faces[soup.triToFace[(c / 3) | 0]];
      let vertex = face[0];
      for (const v of face) {
        if (
          vp[v * 3] === soup.positions[c * 3] &&
          vp[v * 3 + 1] === soup.positions[c * 3 + 1] &&
          vp[v * 3 + 2] === soup.positions[c * 3 + 2]
        ) {
          vertex = v;
          break;
        }
      }
      this.cornerVertex[c] = vertex;
    }

    // Triangles per face.
    this.faceTriStart = new Uint32Array(mesh.faces.length + 1);
    for (let t = 0; t < triCount; t++) this.faceTriStart[soup.triToFace[t] + 1]++;
    for (let f = 0; f < mesh.faces.length; f++) this.faceTriStart[f + 1] += this.faceTriStart[f];
    this.faceTris = new Uint32Array(triCount);
    const fill = this.faceTriStart.slice(0, mesh.faces.length);
    for (let t = 0; t < triCount; t++) this.faceTris[fill[soup.triToFace[t]]++] = t;

    // Unique edges.
    const seen = new Set<number>();
    const pairs: number[] = [];
    for (const face of mesh.faces) {
      for (let i = 0; i < face.length; i++) {
        const u = face[i];
        const w = face[(i + 1) % face.length];
        const a = Math.min(u, w);
        const b = Math.max(u, w);
        const key = a * vertexCount + b;
        if (!seen.has(key)) {
          seen.add(key);
          pairs.push(a, b);
        }
      }
    }
    this.edgeVertices = new Uint32Array(pairs);

    const position = new BufferAttribute(soup.positions, 3);
    this.solidGeometry.setAttribute('position', position);
    this.solidGeometry.setAttribute('normal', new BufferAttribute(soup.normals, 3));
    this.solidGeometry.computeBoundingBox();
    this.solidGeometry.computeBoundingSphere();
    if (this.solidGeometry.boundingBox) this.box.copy(this.solidGeometry.boundingBox);
    this.solid = new Mesh(this.solidGeometry, clay);

    const wirePositions = new Float32Array(this.edgeVertices.length * 3);
    this.wireGeometry.setAttribute('position', new BufferAttribute(wirePositions, 3));
    this.copyPositions(wirePositions, this.edgeVertices, null);
    this.wire = new LineSegments(this.wireGeometry, materials.wire[0]);

    // The tint draws a subset of the solid's triangles: same positions, an index with the selected ones.
    this.tintGeometry.setAttribute('position', position);
    this.tintGeometry.setIndex(new BufferAttribute(new Uint32Array(triCount * 3), 1));
    this.tintGeometry.setDrawRange(0, 0);
    this.tint = new Mesh(this.tintGeometry, materials.tint);
    this.tint.visible = false;

    this.pointGeometry.setAttribute('position', new BufferAttribute(QUAD, 3));
    this.pointGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.pointGeometry.setAttribute('instancePosition', new InstancedBufferAttribute(vp, 3));
    this.pointGeometry.setAttribute('instanceSelected', new InstancedBufferAttribute(this.selectedFlags, 1));
    this.pointGeometry.instanceCount = vertexCount;
    this.points = new Mesh(this.pointGeometry, materials.points);
    this.points.visible = false;

    // Previews move vertices without updating bounds, so culling is off.
    for (const o of [this.solid, this.wire, this.tint, this.points]) {
      o.frustumCulled = false;
      this.group.add(o);
    }
    this.tint.renderOrder = 1;
  }

  setLook(shading: Shading, mode: ElementMode): void {
    const wireframe = shading === 'wireframe';
    this.solid.visible = !wireframe;
    this.wire.material = this.materials.wire[wireframe ? 1 : 0];
    this.points.visible = mode === 'vertex' && this.pointGeometry.instanceCount > 0;
  }

  /** Shows the selection of `edit`. Cost depends on the selection size (plus one pass over the vertices). */
  setSelection(edit: EditState): void {
    if (this.shown === edit) return;
    this.shown = edit;
    const { mesh } = this;

    this.selectedFlags.fill(0);
    for (const v of edit.vertices) if (v < this.selectedFlags.length) this.selectedFlags[v] = 1;
    this.pointGeometry.getAttribute('instanceSelected').needsUpdate = true;

    const faces = edit.faces.filter((f) => f < mesh.faces.length);
    const index = this.tintGeometry.index!;
    const indices = index.array as Uint32Array;
    let n = 0;
    for (const f of faces) {
      for (let i = this.faceTriStart[f]; i < this.faceTriStart[f + 1]; i++) {
        const corner = this.faceTris[i] * 3;
        indices[n++] = corner;
        indices[n++] = corner + 1;
        indices[n++] = corner + 2;
      }
    }
    index.needsUpdate = true;
    this.tintGeometry.setDrawRange(0, n);
    this.tint.visible = n > 0;

    // Thick lines: the selected edges, or the outlines of the selected faces.
    const ends: number[] = [];
    for (const [a, b] of edit.edges) ends.push(a, b);
    for (const f of faces) {
      const face = mesh.faces[f];
      for (let i = 0; i < face.length; i++) ends.push(face[i], face[(i + 1) % face.length]);
    }
    if (this.highlight) {
      this.group.remove(this.highlight);
      this.highlight.geometry.dispose();
      this.highlight = null;
    }
    this.highlightVertices = new Uint32Array(ends);
    if (ends.length > 0) {
      const positions = new Float32Array(ends.length * 3);
      this.copyPositions(positions, this.highlightVertices, null);
      this.highlight = new LineSegments2(new LineSegmentsGeometry().setPositions(positions), this.materials.highlight);
      this.highlight.frustumCulled = false;
      this.group.add(this.highlight);
    }
  }

  /** Starts a preview that moves `vertices`. */
  beginPreview(vertices: readonly number[]): void {
    const vertexCount = this.vertexPositions.length / 3;
    const moved = new Uint8Array(vertexCount);
    for (const v of vertices) if (v < vertexCount) moved[v] = 1;
    const list = Uint32Array.from(vertices.filter((v) => v < vertexCount));
    const base = new Float32Array(list.length * 3);
    list.forEach((v, i) => base.set(this.vertexPositions.subarray(v * 3, v * 3 + 3), i * 3));
    const pick = (source: Uint32Array) => {
      const out: number[] = [];
      for (let i = 0; i < source.length; i++) if (moved[source[i]]) out.push(i);
      return Uint32Array.from(out);
    };
    const corners = pick(this.cornerVertex);
    const faces = new Set<number>();
    for (const c of corners) faces.add(this.triToFace[(c / 3) | 0]);
    this.previewState = {
      vertices: list,
      base,
      corners,
      wireEnds: pick(this.edgeVertices),
      faces: Uint32Array.from(faces),
    };
  }

  /** Shows the preview vertices transformed by `matrix` (local space). The identity restores the mesh. */
  preview(matrix: Matrix4): void {
    const state = this.previewState;
    if (!state) return;
    const e = matrix.elements;
    const vp = this.vertexPositions;
    state.vertices.forEach((v, i) => {
      const x = state.base[i * 3];
      const y = state.base[i * 3 + 1];
      const z = state.base[i * 3 + 2];
      vp[v * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      vp[v * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      vp[v * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    });
    this.pointGeometry.getAttribute('instancePosition').needsUpdate = true;

    const position = this.solidGeometry.getAttribute('position') as BufferAttribute;
    this.copyPositions(position.array as Float32Array, this.cornerVertex, state.corners);
    position.needsUpdate = true;

    const wire = this.wireGeometry.getAttribute('position') as BufferAttribute;
    this.copyPositions(wire.array as Float32Array, this.edgeVertices, state.wireEnds);
    wire.needsUpdate = true;

    if (this.highlight) {
      // instanceStart and instanceEnd share one interleaved buffer, 6 floats per segment.
      const buffer = (this.highlight.geometry.getAttribute('instanceStart') as unknown as { data: BufferAttribute }).data;
      this.copyPositions(buffer.array as Float32Array, this.highlightVertices, null);
      buffer.needsUpdate = true;
    }

    // Flat normals of the faces that changed shape (Newell's method on the previewed positions).
    const normal = this.solidGeometry.getAttribute('normal') as BufferAttribute;
    const normals = normal.array as Float32Array;
    for (const f of state.faces) {
      const face = this.mesh.faces[f];
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < face.length; i++) {
        const a = face[i] * 3;
        const b = face[(i + 1) % face.length] * 3;
        nx += (vp[a + 1] - vp[b + 1]) * (vp[a + 2] + vp[b + 2]);
        ny += (vp[a + 2] - vp[b + 2]) * (vp[a] + vp[b]);
        nz += (vp[a] - vp[b]) * (vp[a + 1] + vp[b + 1]);
      }
      const length = Math.hypot(nx, ny, nz) || 1;
      for (let i = this.faceTriStart[f]; i < this.faceTriStart[f + 1]; i++) {
        const o = this.faceTris[i] * 9;
        for (let c = 0; c < 9; c += 3) {
          normals[o + c] = nx / length;
          normals[o + c + 1] = ny / length;
          normals[o + c + 2] = nz / length;
        }
      }
    }
    normal.needsUpdate = true;
  }

  /** target[i] = position of vertex source[i], for all i or only those listed in `only`. */
  private copyPositions(target: Float32Array, source: Uint32Array, only: Uint32Array | null): void {
    const vp = this.vertexPositions;
    const count = only ? only.length : source.length;
    for (let k = 0; k < count; k++) {
      const i = only ? only[k] : k;
      const v = source[i] * 3;
      target[i * 3] = vp[v];
      target[i * 3 + 1] = vp[v + 1];
      target[i * 3 + 2] = vp[v + 2];
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.highlight?.geometry.dispose();
    this.solidGeometry.dispose();
    this.wireGeometry.dispose();
    this.tintGeometry.dispose();
    this.pointGeometry.dispose();
  }
}

/** Depth bias of the vertex squares in normalised device coordinates. */
const POINT_DEPTH_BIAS = 1e-4;

/** Unit quad; the points material turns it into a screen-sized square. */
const QUAD = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
