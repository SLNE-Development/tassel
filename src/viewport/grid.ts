import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Fog,
  Group,
  LineBasicMaterial,
  LineSegments,
  Vector3,
} from 'three/webgpu';
import { VIEWPORT_COLORS } from './theme';

const HALF_CELLS = 200;
const MAJOR_EVERY = 10;

/**
 * Ground grid that feels infinite: a fixed line grid that follows the point of interest, rescales
 * by powers of ten with the camera distance and fades into the background through scene fog.
 * Plain line materials only, so it behaves the same on WebGPU and WebGL2. The grid is drawn first
 * and writes no depth, so geometry lying exactly on the ground (a plane at y = 0) never z-fights with it.
 */
export class GroundGrid {
  readonly object = new Group();
  readonly fog = new Fog(VIEWPORT_COLORS.background, 1, 100);
  private readonly grid: LineSegments;
  private readonly axisX: LineSegments;
  private readonly axisZ: LineSegments;

  constructor() {
    const positions: number[] = [];
    const colors: number[] = [];
    const minor = new Color(VIEWPORT_COLORS.gridMinor);
    const major = new Color(VIEWPORT_COLORS.gridMajor);
    for (let i = -HALF_CELLS; i <= HALF_CELLS; i++) {
      const c = i % MAJOR_EVERY === 0 ? major : minor;
      positions.push(i, 0, -HALF_CELLS, i, 0, HALF_CELLS, -HALF_CELLS, 0, i, HALF_CELLS, 0, i);
      for (let k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    this.grid = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, depthWrite: false }));
    this.grid.renderOrder = -2;

    this.axisX = axisLine(new Vector3(1, 0, 0), VIEWPORT_COLORS.axisX);
    this.axisZ = axisLine(new Vector3(0, 0, 1), VIEWPORT_COLORS.axisZ);

    for (const o of [this.grid, this.axisX, this.axisZ]) {
      o.frustumCulled = false;
      this.object.add(o);
    }
  }

  /** Adapts cell size, position and fade to the current point of interest and camera distance. */
  update(target: Vector3, distance: number): void {
    const d = Math.max(distance, 1e-6);
    const step = 10 ** Math.floor(Math.log10(d / 4));
    const snap = step * MAJOR_EVERY;
    const cx = Math.round(target.x / snap) * snap;
    const cz = Math.round(target.z / snap) * snap;
    this.grid.scale.setScalar(step);
    this.grid.position.set(cx, 0, cz);
    const extent = step * HALF_CELLS;
    this.axisX.scale.setScalar(extent);
    this.axisX.position.set(cx, 0, 0);
    this.axisZ.scale.setScalar(extent);
    this.axisZ.position.set(0, 0, cz);
    this.fog.near = d * 1.5;
    this.fog.far = d * 5;
  }

  dispose(): void {
    for (const o of [this.grid, this.axisX, this.axisZ]) {
      o.geometry.dispose();
      (o.material as LineBasicMaterial).dispose();
    }
  }
}

function axisLine(direction: Vector3, color: string): LineSegments {
  const geometry = new BufferGeometry();
  const d = direction;
  geometry.setAttribute('position', new Float32BufferAttribute([-d.x, -d.y, -d.z, d.x, d.y, d.z], 3));
  const line = new LineSegments(geometry, new LineBasicMaterial({ color, depthWrite: false }));
  line.renderOrder = -1;
  return line;
}
