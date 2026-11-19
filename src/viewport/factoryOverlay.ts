import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
} from 'three/webgpu';
import { footprintBox } from '../core/minecraft/factory/model';
import { faceNormals } from '../core/minecraft/factory/rotation';
import { modelToWorld } from '../core/minecraft/space';
import type { DocState, FactoryPort, Vec3 } from '../core/types';
import { FACTORY_COLORS } from './theme';

/** Length of a port arrow in world units (blocks). */
const ARROW = 0.32;
/** Length and half width of an arrow head. */
const HEAD = 0.09;
const HEAD_HALF = 0.045;
/** Click tolerance around a marker, in screen pixels. */
const PICK_PX = 12;

export interface PortFrame {
  /** Centre of the opening, world space. */
  centre: Vec3;
  /** Unit vector pointing out of the block. */
  normal: Vec3;
  /** Unit vectors spanning the opening: `size[0]` runs along `u`, `size[1]` along `v`. */
  u: Vec3;
  v: Vec3;
  /** Half extents of the opening in world units. */
  half: [number, number];
}

/** Where a port sits and how its opening is oriented (world space); a port without a face looks along +Y. */
export function portFrame(port: Pick<FactoryPort, 'position' | 'face' | 'size'>): PortFrame {
  const normal: Vec3 = port.face ? [...faceNormals[port.face]] : [0, 1, 0];
  // Walls facing east/west span Z (width) and Y (height); north/south span X and Y; up/down span X and Z.
  const u: Vec3 = normal[0] !== 0 ? [0, 0, 1] : [1, 0, 0];
  const v: Vec3 = normal[1] !== 0 ? [0, 0, 1] : [0, 1, 0];
  return { centre: modelToWorld(port.position), normal, u, v, half: [port.size[0] / 32, port.size[1] / 32] };
}

/** `c + a * x + b * y` */
const plane = (c: Vec3, a: Vec3, x: number, b: Vec3, y: number): Vec3 => [c[0] + a[0] * x + b[0] * y, c[1] + a[1] * x + b[1] * y, c[2] + a[2] * x + b[2] * y];
const along = (c: Vec3, n: Vec3, d: number): Vec3 => [c[0] + n[0] * d, c[1] + n[1] * d, c[2] + n[2] * d];

/** The outline of the opening as a closed loop of four corners (a tiny opening still gets a visible square). */
export function openingCorners(frame: PortFrame, scale = 1): Vec3[] {
  const hu = Math.max(frame.half[0], 0.02) * scale;
  const hv = Math.max(frame.half[1], 0.02) * scale;
  const { centre: c, u, v } = frame;
  return [plane(c, u, -hu, v, -hv), plane(c, u, hu, v, -hv), plane(c, u, hu, v, hv), plane(c, u, -hu, v, hv)];
}

/** Line segments (pairs of points) of the arrow of a port: into the block for inputs, out for outputs, both ways when bidirectional. */
export function arrowSegments(frame: PortFrame, kind: FactoryPort['kind']): Vec3[] {
  const { centre: c, normal: n, u, v } = frame;
  const tip = along(c, n, ARROW);
  const segments: Vec3[] = [c, tip];
  // A head at `point`; the shaft lies on the side `back` (+1 = along the normal, -1 = against it).
  const head = (point: Vec3, back: 1 | -1) => {
    const base = along(point, n, back * HEAD);
    for (const barb of [plane(base, u, HEAD_HALF, v, 0), plane(base, u, -HEAD_HALF, v, 0), plane(base, v, HEAD_HALF, u, 0), plane(base, v, -HEAD_HALF, u, 0)]) segments.push(point, barb);
  };
  if (kind !== 'input') head(tip, -1);
  if (kind !== 'output') head(c, 1);
  return segments;
}

/** Three crossing lines through a point: the marker of a port that has no face yet. */
export function crossSegments(c: Vec3, r = 0.06): Vec3[] {
  return [
    [c[0] - r, c[1], c[2]],
    [c[0] + r, c[1], c[2]],
    [c[0], c[1] - r, c[2]],
    [c[0], c[1] + r, c[2]],
    [c[0], c[1], c[2] - r],
    [c[0], c[1], c[2] + r],
  ];
}

function lineGeometry(points: readonly Vec3[]): BufferGeometry {
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(points.flat(), 3));
}

function lineMaterial(color: string, opacity = 1): LineBasicMaterial {
  const m = new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
  m.fog = false;
  return m;
}

/**
 * Markers of the ports of a factory model, drawn on top of everything: the opening of every port as a square on its face
 * plane and an arrow along the face normal (in = into the block, out = away from it, both = double-headed). The selected
 * port is white with a second outline and a bigger dot; the footprint is a faint box. Plain line and basic materials, so
 * WebGPU and WebGL2 agree.
 */
export class FactoryOverlay {
  readonly object = new Group();
  private readonly lines = {
    input: lineMaterial(FACTORY_COLORS.input),
    output: lineMaterial(FACTORY_COLORS.output),
    bidirectional: lineMaterial(FACTORY_COLORS.bidirectional),
    unset: lineMaterial(FACTORY_COLORS.unset),
    selected: lineMaterial(FACTORY_COLORS.selected),
    footprint: lineMaterial(FACTORY_COLORS.footprint, 0.4),
  };
  private readonly dotGeometry = new SphereGeometry(1, 12, 8);
  private readonly dots: Record<string, MeshBasicMaterial> = {};
  private factory: DocState['factory'];
  private selected: string | null = null;
  private frames: { uid: string; frame: PortFrame }[] = [];

  constructor() {
    this.object.visible = false;
  }

  private dotMaterial(color: string): MeshBasicMaterial {
    return (this.dots[color] ??= new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, fog: false }));
  }

  /** Brings the markers up to date; cheap when neither the machine nor the selection changed. */
  sync(state: DocState, portUid: string | null): void {
    const factory = state.factory;
    if (factory === this.factory && portUid === this.selected) return;
    this.factory = factory;
    this.selected = portUid;
    this.clear();
    this.object.visible = factory !== undefined;
    if (!factory) return;

    // The footprint: the twelve edges of its box.
    const box = footprintBox(factory);
    const lo = modelToWorld(box.min);
    const hi = modelToWorld(box.max);
    const corner = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
    const edges: Vec3[] = [];
    for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) edges.push(corner(i), corner(i | bit));
    this.addLines(new LineSegments(lineGeometry(edges), this.lines.footprint), 998);

    for (const port of factory.ports) {
      const frame = portFrame(port);
      this.frames.push({ uid: port.uid, frame });
      const isSelected = port.uid === portUid;
      const key = isSelected ? 'selected' : port.face ? port.kind : 'unset';
      const material = this.lines[key];
      if (port.face === null) {
        this.addLines(new LineSegments(lineGeometry(crossSegments(frame.centre)), material), 1001);
      } else {
        this.addLines(new LineLoop(lineGeometry(openingCorners(frame)), material), 1001);
        this.addLines(new LineSegments(lineGeometry(arrowSegments(frame, port.kind)), material), 1001);
        // A second, wider outline reads as a thicker line (line widths are fixed at one pixel).
        if (isSelected) this.addLines(new LineLoop(lineGeometry(openingCorners(frame, 1.15)), material), 1001);
      }
      const dot = new Mesh(this.dotGeometry, this.dotMaterial(isSelected ? FACTORY_COLORS.selected : port.face ? FACTORY_COLORS[port.kind] : FACTORY_COLORS.unset));
      dot.scale.setScalar(isSelected ? 0.04 : 0.025);
      dot.position.set(...frame.centre);
      dot.renderOrder = 1002;
      dot.frustumCulled = false;
      this.object.add(dot);
    }
  }

  /**
   * The port whose marker is nearest to the pointer within a few pixels, or null. `x`/`y` are pixels in the canvas.
   * The marker is the opening's centre together with the arrow's shaft, so a click on either selects it.
   */
  pick(x: number, y: number, camera: Camera, width: number, height: number): string | null {
    if (!this.object.visible) return null;
    const project = (p: Vec3) => {
      const v = new Vector3(...p).project(camera);
      return v.z > 1 ? null : { x: ((v.x + 1) / 2) * width, y: ((1 - v.y) / 2) * height };
    };
    let best: string | null = null;
    let bestDistance = PICK_PX;
    for (const { uid, frame } of this.frames) {
      const a = project(frame.centre);
      if (!a) continue;
      const b = project(along(frame.centre, frame.normal, ARROW));
      const d = b ? distanceToSegment(x, y, a, b) : Math.hypot(x - a.x, y - a.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = uid;
      }
    }
    return best;
  }

  private addLines(object: LineLoop | LineSegments, order: number): void {
    object.renderOrder = order;
    object.frustumCulled = false;
    this.object.add(object);
  }

  private clear(): void {
    this.frames = [];
    for (const child of [...this.object.children]) {
      this.object.remove(child);
      if (child instanceof LineSegments || child instanceof LineLoop) child.geometry.dispose();
    }
  }

  dispose(): void {
    this.clear();
    this.dotGeometry.dispose();
    for (const m of Object.values(this.dots)) m.dispose();
    for (const m of Object.values(this.lines)) m.dispose();
  }
}

function distanceToSegment(x: number, y: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}
