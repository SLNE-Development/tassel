import type { Matrix4 } from 'three/webgpu';
import type { PolyMesh } from '../core/types';

/** What element picking needs to know about the edited mesh (see EditView). */
export interface PickMesh {
  readonly mesh: PolyMesh;
  readonly vertexPositions: Float32Array;
  readonly edgeVertices: Uint32Array;
  readonly cornerVertex: Uint32Array;
  readonly triToFace: Uint32Array;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Relative depth tolerance of the occlusion test. */
const DEPTH_EPSILON = 2e-3;

/**
 * Screen-space picking of vertices, edges and faces of one mesh for one camera position.
 * Coordinates are CSS pixels relative to the canvas. With `occlusion`, elements hidden behind the
 * mesh's own faces are not picked: the triangles are rasterised into a small software depth and
 * face-id buffer (one sample per CSS pixel), which is fast enough to do per pick and, unlike
 * raycasts, also for the thousands of elements of a box selection.
 */
export class ElementPicker {
  /** Per vertex: screen x, screen y and 1/w (0 or less: behind the camera). */
  private readonly screen: Float32Array;
  private readonly depth: Float32Array | null = null;
  private readonly ids: Int32Array | null = null;

  constructor(
    private readonly target: PickMesh,
    /** Local space to clip space. */
    matrix: Matrix4,
    private readonly width: number,
    private readonly height: number,
    occlusion: boolean,
  ) {
    const p = target.vertexPositions;
    const e = matrix.elements;
    const count = p.length / 3;
    this.screen = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const z = p[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-9) continue;
      this.screen[i * 3] = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w) * 0.5 + 0.5) * width;
      this.screen[i * 3 + 1] = (0.5 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5) * height;
      this.screen[i * 3 + 2] = 1 / w;
    }
    if (occlusion) {
      this.depth = new Float32Array(width * height);
      this.ids = new Int32Array(width * height).fill(-1);
      this.rasterise();
    }
  }

  /** Nearest visible face per pixel. Triangles reaching behind the camera are left out. */
  private rasterise(): void {
    const { screen, width, height } = this;
    const depth = this.depth!;
    const ids = this.ids!;
    const { cornerVertex, triToFace } = this.target;
    for (let t = 0; t < triToFace.length; t++) {
      const a = cornerVertex[t * 3] * 3;
      const b = cornerVertex[t * 3 + 1] * 3;
      const c = cornerVertex[t * 3 + 2] * 3;
      const ia = screen[a + 2];
      const ib = screen[b + 2];
      const ic = screen[c + 2];
      if (ia <= 0 || ib <= 0 || ic <= 0) continue;
      const ax = screen[a];
      const ay = screen[a + 1];
      const bx = screen[b];
      const by = screen[b + 1];
      const cx = screen[c];
      const cy = screen[c + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const maxX = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const maxY = Math.min(height - 1, Math.floor(Math.max(ay, by, cy)));
      const face = triToFace[t];
      for (let y = minY; y <= maxY; y++) {
        const py = y + 0.5;
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          // Barycentric weights; inside when all have the sign of the area.
          const wa = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
          const wb = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
          const wc = 1 - wa - wb;
          if (wa < 0 || wb < 0 || wc < 0) continue;
          const inverseW = wa * ia + wb * ib + wc * ic;
          const i = y * width + x;
          if (inverseW > depth[i]) {
            depth[i] = inverseW;
            ids[i] = face;
          }
        }
      }
    }
  }

  /**
   * Whether a point of the mesh at this screen position and depth is seen. `owns` tells whether a
   * face contains the element the point belongs to: seeing such a face next to the point proves it
   * visible whatever the slope of the surface; otherwise depths are compared.
   */
  private visible(sx: number, sy: number, inverseW: number, owns: (face: number) => boolean): boolean {
    const { depth, ids, width, height } = this;
    if (!depth || !ids) return true;
    const px = Math.floor(sx);
    const py = Math.floor(sy);
    if (px < 0 || py < 0 || px >= width || py >= height) return false;
    if (ids[py * width + px] < 0) return true;
    let farthest = Infinity;
    for (let y = Math.max(0, py - 1); y <= Math.min(height - 1, py + 1); y++) {
      for (let x = Math.max(0, px - 1); x <= Math.min(width - 1, px + 1); x++) {
        const i = y * width + x;
        if (ids[i] < 0) continue;
        if (owns(ids[i])) return true;
        farthest = Math.min(farthest, depth[i]);
      }
    }
    return inverseW >= farthest * (1 - DEPTH_EPSILON);
  }

  private vertexVisible(v: number): boolean {
    const faces = this.target.mesh.faces;
    const s = this.screen;
    return this.visible(s[v * 3], s[v * 3 + 1], s[v * 3 + 2], (f) => faces[f].includes(v));
  }

  /** Visibility of the point at parameter t (in screen space) of the edge a-b. */
  private edgeVisible(a: number, b: number, t: number): boolean {
    const faces = this.target.mesh.faces;
    const s = this.screen;
    // 1/w is linear in screen space.
    return this.visible(
      s[a * 3] + (s[b * 3] - s[a * 3]) * t,
      s[a * 3 + 1] + (s[b * 3 + 1] - s[a * 3 + 1]) * t,
      s[a * 3 + 2] + (s[b * 3 + 2] - s[a * 3 + 2]) * t,
      (f) => faces[f].includes(a) && faces[f].includes(b),
    );
  }

  /** Nearest visible vertex within `tolerance` pixels, or null. */
  pickVertex(x: number, y: number, tolerance: number): number | null {
    const s = this.screen;
    const best = new Best();
    for (let v = 0; v < s.length / 3; v++) {
      if (s[v * 3 + 2] <= 0) continue;
      const distance = Math.hypot(s[v * 3] - x, s[v * 3 + 1] - y);
      if (distance <= tolerance && best.beats(distance, s[v * 3 + 2]) && this.vertexVisible(v)) {
        best.set(v, distance, s[v * 3 + 2]);
      }
    }
    return best.index < 0 ? null : best.index;
  }

  /** Nearest visible edge within `tolerance` pixels, or null. Edges reaching behind the camera are skipped. */
  pickEdge(x: number, y: number, tolerance: number): [number, number] | null {
    const s = this.screen;
    const e = this.target.edgeVertices;
    const best = new Best();
    for (let i = 0; i < e.length; i += 2) {
      const a = e[i] * 3;
      const b = e[i + 1] * 3;
      if (s[a + 2] <= 0 || s[b + 2] <= 0) continue;
      const dx = s[b] - s[a];
      const dy = s[b + 1] - s[a + 1];
      const lengthSq = dx * dx + dy * dy;
      const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - s[a]) * dx + (y - s[a + 1]) * dy) / lengthSq)) : 0;
      const distance = Math.hypot(s[a] + dx * t - x, s[a + 1] + dy * t - y);
      if (distance > tolerance) continue;
      const inverseW = s[a + 2] + (s[b + 2] - s[a + 2]) * t;
      if (best.beats(distance, inverseW) && this.edgeVisible(e[i], e[i + 1], t)) best.set(i, distance, inverseW);
    }
    return best.index < 0 ? null : [e[best.index], e[best.index + 1]];
  }

  /** Visible vertices inside the rectangle. */
  boxVertices(rect: Rect): number[] {
    const s = this.screen;
    const out: number[] = [];
    for (let v = 0; v < s.length / 3; v++) {
      if (s[v * 3 + 2] <= 0) continue;
      const x = s[v * 3];
      const y = s[v * 3 + 1];
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1 && this.vertexVisible(v)) out.push(v);
    }
    return out;
  }

  /** Edges with a visible part inside the rectangle. */
  boxEdges(rect: Rect): [number, number][] {
    const s = this.screen;
    const e = this.target.edgeVertices;
    const out: [number, number][] = [];
    for (let i = 0; i < e.length; i += 2) {
      const a = e[i] * 3;
      const b = e[i + 1] * 3;
      if (s[a + 2] <= 0 || s[b + 2] <= 0) continue;
      // Liang-Barsky: the part [t0, t1] of the segment that lies inside the rectangle.
      const dx = s[b] - s[a];
      const dy = s[b + 1] - s[a + 1];
      let t0 = 0;
      let t1 = 1;
      const clip = (p: number, q: number): boolean => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
        return t0 <= t1;
      };
      if (
        !clip(-dx, s[a] - rect.x0) ||
        !clip(dx, rect.x1 - s[a]) ||
        !clip(-dy, s[a + 1] - rect.y0) ||
        !clip(dy, rect.y1 - s[a + 1])
      ) {
        continue;
      }
      const seen = [0.5, 0.2, 0.8].some((k) => this.edgeVisible(e[i], e[i + 1], t0 + (t1 - t0) * k));
      if (seen) out.push([e[i], e[i + 1]]);
    }
    return out;
  }

  /**
   * Faces in the rectangle: with occlusion every face that is seen inside it, without (wireframe)
   * every face whose centre is inside it.
   */
  boxFaces(rect: Rect): number[] {
    const { ids, width, height, screen: s } = this;
    if (ids) {
      const found = new Set<number>();
      const x0 = Math.max(0, Math.floor(rect.x0));
      const x1 = Math.min(width - 1, Math.floor(rect.x1));
      const y0 = Math.max(0, Math.floor(rect.y0));
      const y1 = Math.min(height - 1, Math.floor(rect.y1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const id = ids[y * width + x];
          if (id >= 0) found.add(id);
        }
      }
      return [...found];
    }
    const out: number[] = [];
    this.target.mesh.faces.forEach((face, f) => {
      let x = 0;
      let y = 0;
      for (const v of face) {
        if (s[v * 3 + 2] <= 0) return;
        x += s[v * 3] / face.length;
        y += s[v * 3 + 1] / face.length;
      }
      if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) out.push(f);
    });
    return out;
  }
}

/** Best candidate so far: the nearest in pixels; among (almost) equally near ones the one closest to the camera. */
class Best {
  index = -1;
  private distance = Infinity;
  private inverseW = 0;

  beats(distance: number, inverseW: number): boolean {
    if (distance < this.distance - 0.5) return true;
    return distance <= this.distance + 0.5 && inverseW > this.inverseW;
  }

  set(index: number, distance: number, inverseW: number): void {
    this.index = index;
    this.distance = distance;
    this.inverseW = inverseW;
  }
}
