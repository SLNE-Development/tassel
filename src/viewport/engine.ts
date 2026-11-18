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
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
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
import { evaluateObject } from '../core/modifiers/evaluate';
import type {
  AppState,
  CameraPose,
  DocState,
  PolyMesh,
  SceneObject,
  ScreenshotOptions,
  Shading,
  Tool,
  Transform,
  Vec3,
  ViewportService,
  ViewPreset,
} from '../core/types';
import { EditMaterials, EditView, selectedVertices } from './editMesh';
import { ElementPicker } from './editPick';
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
  /**
   * Set while the object is being edited: it then shows its base mesh with the edit overlays, and
   * `geometry` (the modifier result) is hidden and not kept up to date.
   */
  edit: EditView | null;
}

type Drag =
  | { kind: 'object'; start: Map<string, Vector3>; origin: Vector3 }
  /** `pivot` is the gizmo position at the start, in the object's local space. */
  | { kind: 'edit'; view: EditView; pivot: Vector3 };

const gizmoModes: Record<Exclude<Tool, 'select'>, 'translate' | 'rotate' | 'scale'> = {
  move: 'translate',
  rotate: 'rotate',
  scale: 'scale',
};

const CLICK_TOLERANCE_PX = 4;
/** How close (in CSS pixels) a click must be to a vertex or edge to pick it. */
const PICK_TOLERANCE_PX = 10;
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
  /** Other objects while one is being edited. */
  private readonly clayDim: MeshStandardMaterial;
  private readonly wireDim = new LineBasicMaterial({ color: VIEWPORT_COLORS.wireDim, fog: false });
  private readonly editMaterials = new EditMaterials();
  /** The gizmo attaches to this in edit mode; a child of the edited object's group. */
  private readonly pivot = new Object3D();
  /** Rectangle of a box selection in progress. */
  private readonly boxElement = document.createElement('div');

  private initialised = false;
  private disposed = false;
  private frameRequest = 0;
  private needsSync = true;
  private docId: string | null = null;
  private pointerDown: { x: number; y: number; onGizmo: boolean; box: boolean } | null = null;
  private drag: Drag | null = null;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGPURenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.canvas = this.renderer.domElement as HTMLCanvasElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', outline: 'none' });
    container.appendChild(this.canvas);
    Object.assign(this.boxElement.style, {
      display: 'none',
      position: 'absolute',
      pointerEvents: 'none',
      boxSizing: 'border-box',
      border: `1px solid ${ACCENT_COLOR}`,
      background: `${ACCENT_COLOR}26`,
    });
    container.appendChild(this.boxElement);

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
    const clay = (color: string, glow: number) =>
      new MeshStandardMaterial({
        color,
        roughness: 0.9,
        metalness: 0,
        side: DoubleSide,
        emissive: ACCENT_COLOR,
        emissiveIntensity: glow,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    this.clay = [0, 0.06, 0.1].map((glow) => clay(VIEWPORT_COLORS.clay, glow));
    this.clayDim = clay(VIEWPORT_COLORS.clayDim, 0);
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
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancel);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);

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
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    for (const entry of this.entries.values()) entry.edit?.dispose();
    this.entries.clear();
    this.geometries.dispose();
    this.grid.dispose();
    this.editMaterials.dispose();
    [
      ...this.clay,
      this.clayDim,
      ...this.wireMaterials,
      this.wireDim,
      ...this.overlayMaterials,
      ...this.outlineMaterials,
    ].forEach((m) => m.dispose());
    if (this.initialised) this.renderer.dispose();
    this.canvas.remove();
    this.boxElement.remove();
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

    const edit = state.edit;
    const selected = new Set(state.selection);
    for (const id of state.order) {
      const obj = state.objects[id];
      const entry = this.entries.get(id) ?? this.createEntry(state, obj);
      if (entry.obj.transform !== obj.transform) applyTransform(entry.group, obj.transform);
      entry.obj = obj;
      entry.group.visible = obj.visible;

      if (edit?.objectId === id) {
        // The edited object shows its base mesh, so that element indices match what is clicked.
        if (entry.edit?.mesh !== obj.mesh) {
          entry.edit?.dispose();
          entry.edit = new EditView(obj.mesh, this.editMaterials, this.clay[0]);
          entry.group.add(entry.edit.group);
        }
        entry.edit.setSelection(edit);
        entry.edit.setLook(app.shading, edit.elementMode);
        entry.solid.visible = false;
        if (entry.wire) entry.wire.visible = false;
        if (entry.outline) entry.outline.visible = false;
        continue;
      }

      entry.edit?.dispose();
      entry.edit = null;
      const mesh = evaluateObject(state, id).mesh;
      if (entry.geometry.mesh !== mesh || entry.geometry.smooth !== obj.smooth) this.swapGeometry(entry, mesh, obj.smooth);
      const highlight: Highlight = id === state.activeId ? 2 : selected.has(id) ? 1 : 0;
      this.applyLook(entry, app.shading, highlight, edit !== null);
    }

    // The gizmo: on the active object, or in edit mode on the selected elements.
    let target: Object3D | null = null;
    if (app.tool === 'select') {
      // No gizmo.
    } else if (edit) {
      const entry = this.entries.get(edit.objectId);
      const box = entry?.edit && entry.obj.visible ? this.selectionBox(entry.edit, edit) : null;
      if (entry && box) {
        box.getCenter(this.pivot.position);
        this.pivot.quaternion.identity();
        this.pivot.scale.setScalar(1);
        if (this.pivot.parent !== entry.group) entry.group.add(this.pivot);
        target = this.pivot;
      }
    } else {
      const active = state.activeId ? this.entries.get(state.activeId) : undefined;
      if (active && active.obj.visible) target = active.group;
    }
    if (target && app.tool !== 'select') {
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(gizmoModes[app.tool]);
      // Edit mode works along the object's local axes.
      this.gizmo.setSpace(edit ? 'local' : 'world');
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
  }

  /** Local-space bounding box of the selected elements, or null if nothing is selected. */
  private selectionBox(view: EditView, edit: NonNullable<DocState['edit']>): Box3 | null {
    const box = new Box3();
    const point = new Vector3();
    const count = view.vertexPositions.length / 3;
    for (const v of selectedVertices(view.mesh, edit)) {
      if (v < count) box.expandByPoint(point.fromArray(view.vertexPositions, v * 3));
    }
    return box.isEmpty() ? null : box;
  }

  private createEntry(state: DocState, obj: SceneObject): Entry {
    const geometry = this.geometries.acquire(evaluateObject(state, obj.id).mesh, obj.smooth);
    const group = new Group();
    applyTransform(group, obj.transform);
    const solid = new Mesh(geometry.solid, this.clay[0]);
    solid.userData.id = obj.id;
    group.add(solid);
    this.content.add(group);
    const entry: Entry = { obj, geometry, group, solid, wire: null, outline: null, edit: null };
    this.entries.set(obj.id, entry);
    return entry;
  }

  private removeEntry(id: string, entry: Entry): void {
    if (this.gizmo.object === entry.group || this.pivot.parent === entry.group) {
      this.gizmo.detach();
      this.pivot.removeFromParent();
    }
    entry.edit?.dispose();
    this.content.remove(entry.group);
    this.geometries.release(entry.geometry);
    this.entries.delete(id);
  }

  private swapGeometry(entry: Entry, mesh: PolyMesh, smooth: boolean): void {
    const next = this.geometries.acquire(mesh, smooth);
    this.geometries.release(entry.geometry);
    entry.geometry = next;
    entry.solid.geometry = next.solid;
    // Edge objects are rebuilt lazily by applyLook.
    if (entry.wire) entry.group.remove(entry.wire);
    if (entry.outline) entry.group.remove(entry.outline);
    entry.wire = null;
    entry.outline = null;
  }

  /** `dim`: another object is being edited; this one steps back and shows no selection. */
  private applyLook(entry: Entry, shading: Shading, highlight: Highlight, dim: boolean): void {
    const wireframe = shading === 'wireframe';
    if (dim) highlight = 0;
    entry.solid.visible = !wireframe;
    entry.solid.material = dim ? this.clayDim : this.clay[highlight];

    // All edges: the object itself in wireframe shading, a faint overlay on selected solid objects.
    if (wireframe || highlight > 0) {
      const material = dim ? this.wireDim : wireframe ? this.wireMaterials[highlight] : this.overlayMaterials[highlight - 1];
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

  private docState(): DocState | undefined {
    return useApp.getState().docs[this.docId ?? '']?.state;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const onGizmo = this.gizmo.object !== undefined && this.gizmo.axis !== null;
    this.pointerDown = { x: event.clientX, y: event.clientY, onGizmo, box: false };
  };

  /** In edit mode a left drag that does not start on the gizmo draws a selection rectangle. */
  private readonly onPointerMove = (event: PointerEvent): void => {
    const down = this.pointerDown;
    if (!down || down.onGizmo) return;
    if (!down.box) {
      if (Math.hypot(event.clientX - down.x, event.clientY - down.y) <= CLICK_TOLERANCE_PX) return;
      if (!this.docState()?.edit) return;
      down.box = true;
    }
    const rect = this.canvas.getBoundingClientRect();
    Object.assign(this.boxElement.style, {
      display: 'block',
      left: `${Math.min(down.x, event.clientX) - rect.left}px`,
      top: `${Math.min(down.y, event.clientY) - rect.top}px`,
      width: `${Math.abs(event.clientX - down.x)}px`,
      height: `${Math.abs(event.clientY - down.y)}px`,
    });
  };

  private readonly onPointerCancel = (): void => {
    this.pointerDown = null;
    this.boxElement.style.display = 'none';
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const down = this.pointerDown;
    this.pointerDown = null;
    this.boxElement.style.display = 'none';
    if (!down || down.onGizmo) return;
    this.syncIfNeeded();
    if (down.box) {
      this.boxSelect(down, event);
      return;
    }
    // A drag is not a click.
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > CLICK_TOLERANCE_PX) return;
    if (this.docState()?.edit) this.editClick(event);
    else this.click(event);
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (event.button !== 0 || this.gizmo.axis !== null) return;
    this.syncIfNeeded();
    if (this.docState()?.edit) return;
    const id = this.pick(event.clientX, event.clientY);
    if (id) execute('edit.enter', { id }).catch((error) => console.error(error));
  };

  private click(event: PointerEvent): void {
    const id = this.pick(event.clientX, event.clientY);
    const selection = this.docState()?.selection ?? [];
    let params: { ids: string[]; mode: 'replace' | 'toggle' } | null = null;
    if (id) params = { ids: [id], mode: event.shiftKey ? 'toggle' : 'replace' };
    else if (!event.shiftKey && selection.length > 0) params = { ids: [], mode: 'replace' };
    if (params) execute('scene.select', params).catch((error) => console.error(error));
  }

  // ---------------------------------------------------------------- edit mode picking

  /** The edit state, the view that shows it and a picker for the current camera; null if not ready. */
  private editContext() {
    const edit = this.docState()?.edit;
    const entry = edit ? this.entries.get(edit.objectId) : undefined;
    const view = entry?.edit;
    const rect = this.canvas.getBoundingClientRect();
    if (!edit || !entry || !view || view.shown !== edit || !entry.obj.visible || rect.width < 1 || rect.height < 1) return null;
    this.scene.updateMatrixWorld();
    this.camera.updateMatrixWorld();
    const matrix = new Matrix4()
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .multiply(entry.group.matrixWorld);
    // In wireframe shading the elements behind faces are visible, so they can be picked.
    const occlusion = useApp.getState().shading !== 'wireframe';
    const picker = new ElementPicker(view, matrix, Math.round(rect.width), Math.round(rect.height), occlusion);
    return { edit, view, rect, picker };
  }

  private select(command: string, params: object): void {
    execute(command, params).catch((error) => console.error(error));
  }

  private selectNone(edit: NonNullable<DocState['edit']>): void {
    if (edit.vertices.length + edit.edges.length + edit.faces.length > 0) this.select('mesh.select_none', {});
  }

  /** Click: select the element under the cursor (shift toggles). Alt: edge loop, Ctrl+Alt: edge ring. */
  private editClick(event: PointerEvent): void {
    const context = this.editContext();
    if (!context) return;
    const { edit, view, rect, picker } = context;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (event.altKey) {
      const edge = picker.pickEdge(x, y, PICK_TOLERANCE_PX);
      const command = event.ctrlKey ? 'mesh.select_ring' : 'mesh.select_loop';
      if (edge) this.select(command, { edge, action: event.shiftKey ? 'add' : 'replace' });
      return;
    }

    let params: { indices?: number[]; edges?: [number, number][] } | null = null;
    if (edit.elementMode === 'vertex') {
      const vertex = picker.pickVertex(x, y, PICK_TOLERANCE_PX);
      if (vertex !== null) params = { indices: [vertex] };
    } else if (edit.elementMode === 'edge') {
      const edge = picker.pickEdge(x, y, PICK_TOLERANCE_PX);
      if (edge) params = { edges: [edge] };
    } else {
      const ndc = new Vector2((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObject(view.solid, false)[0];
      if (hit && hit.faceIndex != null) params = { indices: [view.triToFace[hit.faceIndex]] };
    }
    if (params) this.select('mesh.select', { ...params, action: event.shiftKey ? 'toggle' : 'replace' });
    else if (!event.shiftKey) this.selectNone(edit);
  }

  /** Selects the elements inside the dragged rectangle (shift adds to the selection). */
  private boxSelect(down: { x: number; y: number }, event: PointerEvent): void {
    const context = this.editContext();
    if (!context) return;
    const { edit, rect, picker } = context;
    const box = {
      x0: Math.min(down.x, event.clientX) - rect.left,
      y0: Math.min(down.y, event.clientY) - rect.top,
      x1: Math.max(down.x, event.clientX) - rect.left,
      y1: Math.max(down.y, event.clientY) - rect.top,
    };
    const params: { indices?: number[]; edges?: [number, number][] } =
      edit.elementMode === 'vertex'
        ? { indices: picker.boxVertices(box) }
        : edit.elementMode === 'edge'
          ? { edges: picker.boxEdges(box) }
          : { indices: picker.boxFaces(box) };
    const count = (params.indices ?? params.edges ?? []).length;
    if (count > 0) this.select('mesh.select', { ...params, action: event.shiftKey ? 'add' : 'replace' });
    else if (!event.shiftKey) this.selectNone(edit);
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
    const state = this.docState();
    if (this.gizmo.object === this.pivot) {
      const view = state?.edit ? this.entries.get(state.edit.objectId)?.edit : undefined;
      if (!view?.shown) return;
      view.beginPreview(selectedVertices(view.mesh, view.shown));
      this.drag = { kind: 'edit', view, pivot: this.pivot.position.clone() };
      return;
    }
    const active = state?.activeId ? this.entries.get(state.activeId) : undefined;
    if (!state || !active) return;
    const start = new Map<string, Vector3>();
    for (const id of state.selection) {
      const entry = this.entries.get(id);
      if (entry && entry !== active) start.set(id, entry.group.position.clone());
    }
    this.drag = { kind: 'object', start, origin: active.group.position.clone() };
  }

  /**
   * Object mode: while moving, the other selected objects follow the active one by the same
   * translation. Edit mode: the selected vertices follow the gizmo, in the GPU buffers only.
   */
  private readonly onGizmoChange = (): void => {
    const active = this.gizmo.object;
    if (!this.drag || !active) return;
    if (this.drag.kind === 'edit') {
      const { x, y, z } = this.drag.pivot;
      const matrix = new Matrix4()
        .compose(this.pivot.position, this.pivot.quaternion, this.pivot.scale)
        .multiply(new Matrix4().makeTranslation(-x, -y, -z));
      this.drag.view.preview(matrix);
      return;
    }
    if (this.gizmo.mode !== 'translate') return;
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
    // Picks up anything that changed in the store while the drag was in progress.
    this.needsSync = true;
    this.invalidate();
    if (drag.kind === 'edit') {
      this.commitEditDrag(drag.view, drag.pivot);
      return;
    }
    const state = this.docState();
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
  }

  /** Commits an edit-mode gizmo drag as one `mesh.transform` in the object's local space. */
  private commitEditDrag(view: EditView, pivot: Vector3): void {
    const p = this.pivot;
    const params: { pivot: Vec3; translate?: Vec3; rotate?: Vec3; scale?: Vec3 } = { pivot: toVec3(pivot) };
    const translate = toVec3(p.position.clone().sub(pivot));
    const rotate = toVec3({
      x: MathUtils.radToDeg(p.rotation.x),
      y: MathUtils.radToDeg(p.rotation.y),
      z: MathUtils.radToDeg(p.rotation.z),
    });
    const scale = toVec3(p.scale);
    if (!sameVec3(translate, [0, 0, 0])) params.translate = translate;
    if (this.gizmo.mode === 'rotate' && !sameVec3(rotate, [0, 0, 0])) params.rotate = rotate;
    if (this.gizmo.mode === 'scale' && !sameVec3(scale, [1, 1, 1])) params.scale = scale;
    const restore = () => {
      view.preview(new Matrix4());
      this.invalidate();
    };
    if (params.translate || params.rotate || params.scale) {
      execute('mesh.transform', params).catch((error) => {
        console.error(error);
        restore();
      });
    } else {
      restore();
    }
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
        const local = entry?.edit ? entry.edit.box : entry?.geometry.solid.boundingBox;
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

  /** Frames the objects; in edit mode the selected elements, if there are any. */
  private frame(ids: readonly string[]): void {
    this.lookFrom(this.currentDirection(), this.editSelectionBounds() ?? this.bounds(ids));
  }

  private editSelectionBounds(): Sphere | null {
    this.syncIfNeeded();
    const edit = this.docState()?.edit;
    const entry = edit ? this.entries.get(edit.objectId) : undefined;
    const box = edit && entry?.edit ? this.selectionBox(entry.edit, edit) : null;
    if (!entry || !box) return null;
    entry.group.updateMatrix();
    const sphere = box.applyMatrix4(entry.group.matrix).getBoundingSphere(new Sphere());
    // A single vertex still needs some room around it.
    if (!(sphere.radius > 1e-6)) sphere.radius = 0.5;
    return sphere;
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
