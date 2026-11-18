import {
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  Line2NodeMaterial,
  LineBasicMaterial,
  LineSegments,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { execute, useApp } from '../app/store';
import type {
  AppState,
  CameraPose,
  SceneObject,
  ScreenshotOptions,
  Shading,
  Tool,
  Transform,
  Vec3,
  ViewportService,
  ViewPreset,
} from '../core/types';
import { DEFAULT_SPHERE, fitClipPlanes, fitDistance, placeCamera, viewDirection } from './framing';
import { GeometryStore, type MeshGeometry } from './geometry';
import { GroundGrid } from './grid';
import { ACCENT_ACTIVE_COLOR, ACCENT_COLOR, VIEWPORT_COLORS } from './theme';

/** 0 = not selected, 1 = selected, 2 = active. */
type Highlight = 0 | 1 | 2;

interface Entry {
  obj: SceneObject;
  geometry: MeshGeometry;
  /** Carries the object transform; the gizmo attaches to it. */
  group: Group;
  solid: Mesh;
  wire: LineSegments | null;
  outline: LineSegments2 | null;
}

const gizmoModes: Record<Exclude<Tool, 'select'>, 'translate' | 'rotate' | 'scale'> = {
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
};

const CLICK_TOLERANCE_PX = 4;
const FOV = 40;

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const toVec3 = (v: { x: number; y: number; z: number }): Vec3 => [round(v.x), round(v.y), round(v.z)];
const sameVec3 = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

function applyTransform(group: Group, t: Transform): void {
  group.position.set(...t.position);
  group.rotation.set(
    MathUtils.degToRad(t.rotation[0]),
    MathUtils.degToRad(t.rotation[1]),
    MathUtils.degToRad(t.rotation[2]),
    'XYZ',
  );
  group.scale.set(...t.scale);
}

/**
 * The imperative three.js side of the viewport. It mirrors the active document into a three scene
 * (diffing by reference identity), renders on demand and turns mouse input into commands.
 */
export class ViewportEngine {
  readonly service: ViewportService;
  /** 'webgpu' or 'webgl2' once the renderer is initialised. */
  backend: 'webgpu' | 'webgl2' | null = null;

  private readonly renderer: WebGPURenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: ReturnType<TransformControls['getHelper']>;
  private readonly grid = new GroundGrid();
  private readonly lightRig = new Group();
  private readonly content = new Group();
  private readonly geometries = new GeometryStore();
  private readonly entries = new Map<string, Entry>();
  private readonly raycaster = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly ready: Promise<void>;
  private readonly cameraByDoc = new Map<string, CameraPose>();

  private readonly clay: MeshStandardMaterial[];
  /** Wireframe shading for [not selected, selected, active]. */
  private readonly wireMaterials = [VIEWPORT_COLORS.wire, ACCENT_COLOR, ACCENT_ACTIVE_COLOR].map(
    (color) => new LineBasicMaterial({ color, fog: false }),
  );
  /** Faint all-edges overlay on solid objects for [selected, active]. */
  private readonly overlayMaterials = [ACCENT_COLOR, ACCENT_ACTIVE_COLOR].map(
    (color) => new LineBasicMaterial({ color, fog: false, transparent: true, opacity: 0.4, depthWrite: false }),
  );
  private readonly outlineMaterials: Line2NodeMaterial[];

  private initialised = false;
  private disposed = false;
  private frameRequest = 0;
  private needsSync = true;
  private docId: string | null = null;
  private pointerDown: { x: number; y: number; onGizmo: boolean } | null = null;
  private drag: { start: Map<string, Vector3>; origin: Vector3 } | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGPURenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement as HTMLCanvasElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', outline: 'none' });
    container.appendChild(this.canvas);

    this.scene.background = new Color(VIEWPORT_COLORS.background);
    this.scene.fog = this.grid.fog;
    this.scene.add(this.grid.object, this.content, this.lightRig);

    // Soft studio lighting. The rig follows the camera so every view direction is lit the same way.
    this.scene.add(new HemisphereLight('#e4e9f2', '#3a3632', 1.5));
    const key = new DirectionalLight('#fff3e4', 2.4);
    key.position.set(-3, 5, 4);
    const fill = new DirectionalLight('#a9bfe6', 0.7);
    fill.position.set(5, -1, 2);
    this.lightRig.add(key, fill);

    // Clay for [not selected, selected, active]; the offset keeps edge overlays free of z-fighting.
    this.clay = [0, 0.06, 0.1].map(
      (glow) =>
        new MeshStandardMaterial({
          color: VIEWPORT_COLORS.clay,
          roughness: 0.9,
          metalness: 0,
          side: DoubleSide,
          emissive: ACCENT_COLOR,
          emissiveIntensity: glow,
          fog: false,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
    );
    this.outlineMaterials = [ACCENT_COLOR, ACCENT_ACTIVE_COLOR].map((color) => {
      const material = new Line2NodeMaterial({ color, linewidth: 2, worldUnits: false });
      material.fog = false;
      return material;
    });

    this.camera.position.set(6.5, 4.5, 8);
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = false;
    this.orbit.zoomSpeed = 1.2;
    // Left is reserved for selection. With shift (or ctrl) a rotate drag pans.
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.ROTATE };
    this.orbit.addEventListener('change', this.invalidate);
    this.orbit.update();

    this.gizmo = new TransformControls(this.camera, this.canvas);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', this.invalidate);
    this.gizmo.addEventListener('objectChange', this.onGizmoChange);
    this.gizmo.addEventListener('dragging-changed', this.onGizmoDragging);

    // Registered after the controls so that the gizmo has already updated its hover state.
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('mousedown', this.onMouseDown);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribe = useApp.subscribe(() => {
      this.needsSync = true;
      this.invalidate();
    });

    this.service = {
      screenshot: (opts) => this.screenshot(opts),
      getCamera: () => this.getCamera(),
      setCamera: (pose) => this.setCamera(pose),
      setView: (preset) => this.setView(preset),
      frame: (ids) => this.frame(ids),
    };

    this.ready = this.renderer.init().then(() => {
      if (this.disposed) {
        this.renderer.dispose();
        return;
      }
      this.initialised = true;
      this.backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
      // Lets the UI (and tests) see which backend is in use.
      this.container.dataset.backend = this.backend;
      this.resize();
    });
    this.ready.catch((error) => console.error('Viewport: renderer could not be initialised', error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.entries.clear();
    this.geometries.dispose();
    this.grid.dispose();
    [...this.clay, ...this.wireMaterials, ...this.overlayMaterials, ...this.outlineMaterials].forEach((m) => m.dispose());
    if (this.initialised) this.renderer.dispose();
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- rendering

  /** Requests a render on the next animation frame. Multiple requests collapse into one. */
  private readonly invalidate = (): void => {
    if (this.frameRequest || this.disposed) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.renderNow();
    });
  };

  private renderNow(): void {
    if (!this.initialised || this.disposed) return;
    this.syncIfNeeded();
    this.draw(this.camera, this.orbit.target);
  }

  private draw(camera: PerspectiveCamera, target: Vector3): void {
    const distance = camera.position.distanceTo(target);
    fitClipPlanes(camera, distance);
    this.grid.update(target, distance);
    this.lightRig.quaternion.copy(camera.quaternion);
    this.renderer.render(this.scene, camera);
  }

  private resize(): void {
    const width = Math.max(1, Math.floor(this.container.clientWidth));
    const height = Math.max(1, Math.floor(this.container.clientHeight));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (!this.initialised) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    // Resizing clears the canvas, so draw right away instead of waiting for the next frame.
    this.renderNow();
  }

  // ---------------------------------------------------------------- state → scene

  private syncIfNeeded(): void {
    if (!this.needsSync || this.drag) return;
    this.needsSync = false;
    this.sync(useApp.getState());
  }

  private sync(app: AppState): void {
    const doc = app.docs[app.activeDocId];
    if (!doc) return;

    // Each document keeps its own camera.
    if (this.docId !== doc.id) {
      if (this.docId) this.cameraByDoc.set(this.docId, this.getCamera());
      for (const id of this.cameraByDoc.keys()) if (!app.docs[id]) this.cameraByDoc.delete(id);
      const pose = this.cameraByDoc.get(doc.id);
      if (pose) this.setCamera(pose);
      this.docId = doc.id;
    }

    const state = doc.state;
    for (const [id, entry] of this.entries) {
      if (!state.objects[id]) this.removeEntry(id, entry);
    }

    const selected = new Set(state.selection);
    for (const id of state.order) {
      const obj = state.objects[id];
      let entry = this.entries.get(id);
      if (!entry) {
        entry = this.createEntry(obj);
      } else if (entry.obj !== obj) {
        if (entry.obj.mesh !== obj.mesh) this.swapGeometry(entry, obj);
        if (entry.obj.transform !== obj.transform) applyTransform(entry.group, obj.transform);
        entry.obj = obj;
      }
      entry.group.visible = obj.visible;
      const highlight: Highlight = id === state.activeId ? 2 : selected.has(id) ? 1 : 0;
      this.applyLook(entry, app.shading, highlight);
    }

    const active = state.activeId ? this.entries.get(state.activeId) : undefined;
    if (active && active.obj.visible && app.tool !== 'select') {
      if (this.gizmo.object !== active.group) this.gizmo.attach(active.group);
      this.gizmo.setMode(gizmoModes[app.tool]);
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  private createEntry(obj: SceneObject): Entry {
    const geometry = this.geometries.acquire(obj.mesh);
    const group = new Group();
    applyTransform(group, obj.transform);
    const solid = new Mesh(geometry.solid, this.clay[0]);
    solid.userData.id = obj.id;
    group.add(solid);
    this.content.add(group);
    const entry: Entry = { obj, geometry, group, solid, wire: null, outline: null };
    this.entries.set(obj.id, entry);
    return entry;
  }

  private removeEntry(id: string, entry: Entry): void {
    if (this.gizmo.object === entry.group) this.gizmo.detach();
    this.content.remove(entry.group);
    this.geometries.release(entry.obj.mesh);
    this.entries.delete(id);
  }

  private swapGeometry(entry: Entry, obj: SceneObject): void {
    const next = this.geometries.acquire(obj.mesh);
    this.geometries.release(entry.obj.mesh);
    entry.geometry = next;
    entry.solid.geometry = next.solid;
    // Edge objects are rebuilt lazily by applyLook.
    if (entry.wire) entry.group.remove(entry.wire);
    if (entry.outline) entry.group.remove(entry.outline);
    entry.wire = null;
    entry.outline = null;
  }

  private applyLook(entry: Entry, shading: Shading, highlight: Highlight): void {
    const wireframe = shading === 'wireframe';
    entry.solid.visible = !wireframe;
    entry.solid.material = this.clay[highlight];

    // All edges: the object itself in wireframe shading, a faint overlay on selected solid objects.
    if (wireframe || highlight > 0) {
      const material = wireframe ? this.wireMaterials[highlight] : this.overlayMaterials[highlight - 1];
      if (!entry.wire) {
        entry.wire = new LineSegments(entry.geometry.wire, material);
        entry.group.add(entry.wire);
      }
      entry.wire.material = material;
      entry.wire.visible = true;
    } else if (entry.wire) {
      entry.wire.visible = false;
    }

    // Wide lines along borders and creases of selected objects.
    const outlineGeometry = highlight > 0 ? entry.geometry.outline : null;
    if (outlineGeometry) {
      const material = this.outlineMaterials[highlight - 1];
      if (!entry.outline) {
        entry.outline = new LineSegments2(outlineGeometry, material);
        entry.group.add(entry.outline);
      }
      entry.outline.material = material;
      entry.outline.visible = true;
    } else if (entry.outline) {
      entry.outline.visible = false;
    }
  }

  // ---------------------------------------------------------------- mouse

  private readonly onMouseDown = (event: MouseEvent): void => {
    // Keeps the browser from starting middle-click autoscroll.
    if (event.button === 1) event.preventDefault();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const onGizmo = this.gizmo.object !== undefined && this.gizmo.axis !== null;
    this.pointerDown = { x: event.clientX, y: event.clientY, onGizmo };
  };

  private readonly onPointerCancel = (): void => {
    this.pointerDown = null;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || down.onGizmo) return;
    // A drag is not a click.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    this.click(event);
  };

  private click(event: PointerEvent): void {
    this.syncIfNeeded();
    const id = this.pick(event.clientX, event.clientY);
    const selection = useApp.getState().docs[this.docId ?? '']?.state.selection ?? [];
    let params: { ids: string[]; mode: 'replace' | 'toggle' } | null = null;
    if (id) params = { ids: [id], mode: event.shiftKey ? 'toggle' : 'replace' };
    else if (!event.shiftKey && selection.length > 0) params = { ids: [], mode: 'replace' };
    if (params) execute('scene.select', params).catch((error) => console.error(error));
  }

  /** Id of the frontmost visible object under the given client coordinates. */
  private pick(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const targets: Mesh[] = [];
    for (const entry of this.entries.values()) if (entry.obj.visible) targets.push(entry.solid);
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? (hit.object.userData.id as string) : null;
  }

  // ---------------------------------------------------------------- gizmo

  private readonly onGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    this.orbit.enabled = !dragging;
    if (dragging) this.beginDrag();
    else this.endDrag();
  };

  private beginDrag(): void {
    const state = useApp.getState().docs[this.docId ?? '']?.state;
    const active = state?.activeId ? this.entries.get(state.activeId) : undefined;
    if (!state || !active) return;
    const start = new Map<string, Vector3>();
    for (const id of state.selection) {
      const entry = this.entries.get(id);
      if (entry && entry !== active) start.set(id, entry.group.position.clone());
    }
    this.drag = { start, origin: active.group.position.clone() };
  }

  /** While moving, the other selected objects follow the active one by the same translation. */
  private readonly onGizmoChange = (): void => {
    const active = this.gizmo.object;
    if (!this.drag || !active || this.gizmo.mode !== 'translate') return;
    const delta = active.position.clone().sub(this.drag.origin);
    for (const [id, start] of this.drag.start) {
      this.entries.get(id)?.group.position.copy(start).add(delta);
    }
  };

  /** Commits the dragged transform as one command, i.e. one undo step. */
  private endDrag(): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    const state = useApp.getState().docs[this.docId ?? '']?.state;
    const active = state?.activeId ? this.entries.get(state.activeId) : undefined;
    const items: { id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }[] = [];
    if (state && active && state.objects[active.obj.id]) {
      const g = active.group;
      const t = state.objects[active.obj.id].transform;
      const item: (typeof items)[number] = { id: active.obj.id };
      const position = toVec3(g.position);
      const rotation = toVec3({
        x: MathUtils.radToDeg(g.rotation.x),
        y: MathUtils.radToDeg(g.rotation.y),
        z: MathUtils.radToDeg(g.rotation.z),
      });
      const scale = toVec3(g.scale);
      if (!sameVec3(position, t.position)) item.position = position;
      if (this.gizmo.mode === 'rotate' && !sameVec3(rotation, t.rotation)) item.rotation = rotation;
      if (this.gizmo.mode === 'scale' && !sameVec3(scale, t.scale)) item.scale = scale;
      if (item.position || item.rotation || item.scale) items.push(item);
      if (this.gizmo.mode === 'translate') {
        for (const id of drag.start.keys()) {
          const entry = this.entries.get(id);
          const obj = state.objects[id];
          if (!entry || !obj) continue;
          const p = toVec3(entry.group.position);
          if (!sameVec3(p, obj.transform.position)) items.push({ id, position: p });
        }
      }
    }
    if (items.length > 0) {
      execute('scene.set_transform', { items }).catch((error) => {
        console.error(error);
        this.resetTransforms();
      });
    } else {
      this.resetTransforms();
    }
    // Picks up anything that changed in the store while the drag was in progress.
    this.needsSync = true;
    this.invalidate();
  }

  /** Puts all three objects back to their document transform. */
  private resetTransforms(): void {
    for (const entry of this.entries.values()) applyTransform(entry.group, entry.obj.transform);
    this.invalidate();
  }

  // ---------------------------------------------------------------- camera / service

  private getCamera(): CameraPose {
    return { position: toVec3(this.camera.position), target: toVec3(this.orbit.target) };
  }

  private setCamera(pose: Partial<CameraPose>): void {
    if (pose.position) this.camera.position.set(...pose.position);
    if (pose.target) this.orbit.target.set(...pose.target);
    // Camera and target must not coincide.
    if (this.camera.position.distanceToSquared(this.orbit.target) < 1e-12) this.camera.position.z += 1;
    this.orbit.update();
    this.invalidate();
  }

  /** World-space bounding sphere of the visible objects among `ids` (all objects if empty). */
  private bounds(ids: readonly string[]): Sphere {
    this.syncIfNeeded();
    const collect = (list: Iterable<Entry | undefined>): Box3 => {
      const box = new Box3();
      const part = new Box3();
      for (const entry of list) {
        const local = entry?.geometry.solid.boundingBox;
        if (!entry || !entry.obj.visible || !local || local.isEmpty()) continue;
        entry.group.updateMatrix();
        box.union(part.copy(local).applyMatrix4(entry.group.matrix));
      }
      return box;
    };
    let box = collect(ids.map((id) => this.entries.get(id)));
    if (box.isEmpty()) box = collect(this.entries.values());
    if (box.isEmpty()) return DEFAULT_SPHERE.clone();
    const sphere = box.getBoundingSphere(new Sphere());
    if (!(sphere.radius > 1e-6)) sphere.radius = 1;
    return sphere;
  }

  private currentDirection(): Vector3 {
    const direction = this.camera.position.clone().sub(this.orbit.target);
    return direction.lengthSq() > 0 ? direction.normalize() : viewDirection('iso');
  }

  private lookFrom(direction: Vector3, sphere: Sphere): void {
    const distance = fitDistance(sphere.radius, this.camera.fov, this.camera.aspect);
    this.orbit.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
    this.orbit.update();
    this.invalidate();
  }

  private setView(preset: ViewPreset): void {
    this.lookFrom(viewDirection(preset), this.bounds([]));
  }

  private frame(ids: readonly string[]): void {
    this.lookFrom(this.currentDirection(), this.bounds(ids));
  }

  private async screenshot(opts: ScreenshotOptions): Promise<string> {
    await this.ready;
    if (this.disposed || !this.initialised) throw new Error('The 3D viewport is not available');
    this.syncIfNeeded();
    const width = Math.max(1, Math.round(opts.width));
    const height = Math.max(1, Math.round(opts.height));

    // A temporary camera, so the user's camera never moves.
    const camera = new PerspectiveCamera(this.camera.fov, width / height);
    const target = this.orbit.target.clone();
    if (opts.view === 'current' && !opts.fit) {
      camera.position.copy(this.camera.position);
      camera.quaternion.copy(this.camera.quaternion);
    } else {
      const sphere = this.bounds([]);
      const direction = opts.view === 'current' ? this.currentDirection() : viewDirection(opts.view);
      placeCamera(camera, sphere, direction);
      target.copy(sphere.center);
    }
    camera.updateMatrixWorld();

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) throw new Error('Could not create a canvas for the screenshot');

    const pixelRatio = this.renderer.getPixelRatio();
    const gizmoVisible = this.gizmoHelper.visible;
    this.gizmoHelper.visible = false;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(width, height, false);
      this.draw(camera, target);
      // Read the canvas in the same task, before the browser presents (and may discard) the frame.
      context.drawImage(this.canvas, 0, 0, width, height);
    } finally {
      this.gizmoHelper.visible = gizmoVisible;
      this.renderer.setPixelRatio(pixelRatio);
      this.resize();
    }
    return output.toDataURL('image/png').slice('data:image/png;base64,'.length);
  }
}
