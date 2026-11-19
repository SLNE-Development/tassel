import {
  Box3,
  DoubleSide,
  Line2NodeMaterial,
  LineBasicMaterial,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Sphere,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { frameOf, pause, usePlayback } from '../app/playback';
import { getAppearance, onAppearanceChange } from '../app/preferences';
import { execute, useApp } from '../app/store';
import { animatedState, cameraAt } from '../core/animation';
import { describeCamera, fitDistance as fitShot, screenshotViews, sheetLayout, viewLabel, type Rect } from '../core/screenshotViews';
import { isMinecraft } from '../core/formats';
import type { Preferences } from '../core/preferences';
import type {
  AppState,
  CameraPose,
  DocState,
  ScreenshotOptions,
  ScreenshotResult,
  ScreenshotView,
  ScreenshotViewInfo,
  ShotSequence,
  Tool,
  Transform,
  Vec3,
  ViewDocument,
  ViewportService,
  ViewPreset,
} from '../core/types';
import { applyTransform, boxCorners, DocScene, selectionBox, Stage, type Entry, type SceneLooks } from './docScene';
import { snapSteps, type SnapSteps } from './snapping';
import { EditMaterials, EditView, selectedVertices } from './editMesh';
import { ElementPicker } from './editPick';
import { DEFAULT_SPHERE, fitDistance, viewDirection } from './framing';
import { GeometryStore } from './geometry';
import { PaintView } from './paintView';
import { rotateAbout, scaleAbout } from './groupTransform';
import { SurfaceMaterials } from './surfaces';
import { VIEWPORT_PALETTES, type ViewportPalette } from './theme';

type Drag =
  | { kind: 'object'; start: Map<string, Vector3>; origin: Vector3 }
  /** Several objects rotated or scaled as a unit about `pivot` (world space); `start` are their transforms before. */
  | { kind: 'group'; start: Map<string, Transform>; pivot: Vector3 }
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
/** Wheel zoom factor of the orbit controls at zoomSpeed 1. */
const BASE_ZOOM_SPEED = 1.2;

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const toVec3 = (v: { x: number; y: number; z: number }): Vec3 => [round(v.x), round(v.y), round(v.z)];
const sameVec3 = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The look in which a document that is not the visible tab is drawn (only what bounding boxes need). */
const plainLook = (app: AppState): AppState => ({ ...app, workspace: 'modeling', shading: 'solid' });

/**
 * The imperative three.js side of the viewport. It mirrors the active document into a three scene
 * (`DocScene`, diffing by reference identity), renders on demand and turns mouse input into commands.
 *
 * Documents in the background (open, but not the visible tab) never enter that scene: a screenshot of
 * one builds a second `DocScene` on a stage of its own for the duration of the picture, and their
 * cameras are kept in `cameraByDoc`.
 */
export class ViewportEngine {
  readonly service: ViewportService;
  /** 'webgpu' or 'webgl2' once the renderer is initialised. */
  backend: 'webgpu' | 'webgl2' | null = null;

  private readonly renderer: WebGPURenderer;
  private readonly canvas: HTMLCanvasElement;
  /** What the user sees: background, grid and lights around the objects of the visible document. */
  private readonly stage = new Stage();
  private readonly scene = this.stage.scene;
  /** The same surroundings for pictures of documents in the background; made when first needed. */
  private backStage: Stage | null = null;
  private readonly camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  private readonly orbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: ReturnType<TransformControls['getHelper']>;
  private readonly grid = this.stage.grid;
  private readonly geometries = new GeometryStore();
  private readonly looks: SceneLooks;
  /** The objects of the visible document. */
  private readonly docScene: DocScene;
  private readonly entries: Map<string, Entry>;
  private readonly raycaster = new Raycaster();
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeAppearance: () => void;
  private readonly unsubscribePlayback: () => void;
  /**
   * "Kamera-Ansicht": while `previewing`, the viewport is drawn through this camera, posed from the
   * animated camera at the playhead. The user's own camera (`camera` with `orbit`) is not touched and
   * is what the viewport returns to.
   */
  private readonly animCamera = new PerspectiveCamera(40, 1, 0.1, 1000);
  private readonly animTarget = new Vector3();
  private previewing = false;
  private readonly ready: Promise<void>;
  /**
   * The cameras of the documents in the background: where the user left them, or where a view command
   * for that document put them. A document without an entry has not been looked at or posed yet and
   * takes over the camera that is current when it becomes visible.
   */
  private readonly cameraByDoc = new Map<string, CameraPose>();

  private readonly clay: MeshStandardMaterial[];
  /** Wireframe shading for [not selected, selected, active]. */
  private readonly wireMaterials = [0, 1, 2].map(() => new LineBasicMaterial({ fog: false }));
  /** Faint all-edges overlay on solid objects for [selected, active]. */
  private readonly overlayMaterials = [0, 1].map(
    () => new LineBasicMaterial({ fog: false, transparent: true, opacity: 0.4, depthWrite: false }),
  );
  private readonly outlineMaterials: Line2NodeMaterial[];
  /** Other objects while one is being edited. */
  private readonly clayDim: MeshStandardMaterial;
  private readonly wireDim = new LineBasicMaterial({ fog: false });
  private readonly editMaterials = new EditMaterials();
  /** PBR materials and the UV checker; a texture that finishes decoding asks for another sync. */
  private readonly ambient = this.stage.ambient;
  private readonly surfaces = new SurfaceMaterials(() => {
    this.needsSync = true;
    this.invalidate();
  });
  /** The gizmo attaches to this in edit mode; a child of the edited object's group. */
  private readonly pivot = new Object3D();
  /** The rotate / scale gizmo attaches to this when several objects are selected: the centre of their bounding box. */
  private readonly groupPivot = new Object3D();
  /** Painting on the active object in the paint workspace; it handles the left mouse button there. */
  private readonly paintView: PaintView;
  /** Rectangle of a box selection in progress. */
  private readonly boxElement = document.createElement('div');

  private initialised = false;
  private disposed = false;
  private frameRequest = 0;
  private needsSync = true;
  private docId: string | null = null;
  private preferences: Preferences | null = null;
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
    });
    container.appendChild(this.boxElement);

    // Clay for [not selected, selected, active]; the offset keeps edge overlays free of z-fighting.
    const clay = (glow: number) =>
      new MeshStandardMaterial({
        roughness: 0.9,
        metalness: 0,
        side: DoubleSide,
        emissiveIntensity: glow,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
    this.clay = [0, 0.06, 0.1].map(clay);
    this.clayDim = clay(0);
    this.outlineMaterials = [0, 1].map(() => {
      const material = new Line2NodeMaterial({ linewidth: 2, worldUnits: false });
      material.fog = false;
      return material;
    });
    this.looks = {
      geometries: this.geometries,
      surfaces: this.surfaces,
      clay: this.clay,
      clayDim: this.clayDim,
      wireMaterials: this.wireMaterials,
      wireDim: this.wireDim,
      overlayMaterials: this.overlayMaterials,
      outlineMaterials: this.outlineMaterials,
      editMaterials: this.editMaterials,
    };
    this.docScene = new DocScene(this.looks, (entry) => {
      // Nothing may stay attached to an object that leaves the scene.
      if (this.gizmo.object === entry.group || this.pivot.parent === entry.group) {
        this.gizmo.detach();
        this.pivot.removeFromParent();
      }
    });
    this.entries = this.docScene.entries;
    this.scene.add(this.docScene.content);

    this.camera.position.set(6.5, 4.5, 8);
    this.orbit = new OrbitControls(this.camera, this.canvas);
    this.orbit.enableDamping = false;
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
    this.paintView = new PaintView({
      canvas: this.canvas,
      container,
      camera: this.camera,
      raycaster: this.raycaster,
      sync: () => this.syncIfNeeded(),
      target: (id) => {
        const entry = this.entries.get(id);
        return entry && !entry.edit && entry.obj.visible ? { solid: entry.solid, mesh: entry.geometry.mesh } : null;
      },
      solids: () => [...this.entries.values()].filter((entry) => entry.obj.visible && !entry.edit).map((entry) => entry.solid),
      refresh: () => {
        this.needsSync = true;
        this.invalidate();
      },
    });
    this.surfaces.paint = this.paintView;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    // A change of the interface zoom changes the device pixel ratio, not always the viewport's size.
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('keydown', this.onModifierKey);
    window.addEventListener('keyup', this.onModifierKey);
    this.applyAppearance();
    this.unsubscribeAppearance = onAppearanceChange(this.applyAppearance);
    this.applyPreferences(useApp.getState().preferences);
    this.unsubscribe = useApp.subscribe((app) => {
      this.applyPreferences(app.preferences);
      this.needsSync = true;
      this.invalidate();
    });
    // The playhead moved, or the camera preview was switched: show the document at that frame.
    this.unsubscribePlayback = usePlayback.subscribe(() => {
      this.needsSync = true;
      this.invalidate();
    });

    this.service = {
      screenshot: (opts, doc) => this.screenshot(opts, doc),
      sequence: (doc) => this.sequence(doc),
      getCamera: (doc) => this.getCamera(doc),
      setCamera: (pose, doc) => this.setCamera(pose, doc),
      setView: (preset, doc) => this.setView(preset, doc),
      frame: (ids, doc) => this.frame(ids, doc),
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
      this.surfaces.init(this.renderer);
      this.resize();
    });
    this.ready.catch((error) => console.error('Viewport: renderer could not be initialised', error));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.unsubscribe();
    this.unsubscribeAppearance();
    this.unsubscribePlayback();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener('keydown', this.onModifierKey);
    window.removeEventListener('keyup', this.onModifierKey);
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.paintView.dispose();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    for (const entry of this.entries.values()) entry.edit?.dispose();
    this.entries.clear();
    this.geometries.dispose();
    this.stage.dispose();
    this.backStage?.dispose();
    this.editMaterials.dispose();
    this.surfaces.dispose();
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
    this.stage.draw(this.renderer, this.viewCamera, this.previewing ? this.animTarget : this.orbit.target);
  }

  /** The camera the viewport is drawn through: the user's, or the animated one in the camera preview. */
  private get viewCamera(): PerspectiveCamera {
    return this.previewing ? this.animCamera : this.camera;
  }

  /**
   * What the viewport shows of a document: with an animation, the pose at the playhead; in edit mode the
   * static pose (the mesh is edited where the object rests). Objects that do not move keep their identity.
   */
  private displayed(doc: { id: string; state: DocState }): DocState {
    const state = doc.state;
    return state.animation && !state.edit ? animatedState(state, frameOf(doc.id)) : state;
  }

  /** Switches the camera preview on or off for the document on screen and poses its camera for the playhead. */
  private updatePreview(app: AppState, doc: { id: string; state: DocState }): void {
    const playback = usePlayback.getState();
    const state = doc.state;
    // Painting and edit-mode picking work with the user's camera.
    const frame = playback.cameraView && !state.edit && app.workspace !== 'paint' ? cameraAt(state.animation, frameOf(doc.id, playback)) : null;
    this.previewing = frame !== null;
    if (frame) {
      const camera = this.animCamera;
      camera.fov = frame.fov;
      camera.aspect = this.camera.aspect;
      camera.position.set(...frame.position);
      this.animTarget.set(...frame.target);
      // Camera and target must not coincide.
      if (camera.position.distanceToSquared(this.animTarget) < 1e-12) camera.position.z += 1;
      camera.up.set(0, 1, 0);
      camera.lookAt(this.animTarget);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    }
    // The preview is not the user's camera to move.
    this.orbit.enabled = !this.previewing && !this.drag;
    if (this.gizmo.camera !== this.viewCamera) this.gizmo.camera = this.viewCamera;
  }

  private readonly onWindowResize = (): void => this.resize();

  /**
   * Sizes the drawing buffer to the canvas as it appears on screen, so the image stays sharp at
   * every interface scale. The webview zoom of the desktop app is part of devicePixelRatio; a CSS
   * zoom (plain browser) is not, and shows as the difference between the bounding rectangle (what
   * is on screen, and what pointer positions refer to) and the layout size.
   */
  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const cssZoom = this.container.getBoundingClientRect().width / width || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.animCamera.aspect = width / height;
    this.animCamera.updateProjectionMatrix();
    if (!this.initialised) return;
    this.renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * cssZoom, 2));
    this.renderer.setSize(width, height, false);
    // Resizing clears the canvas, so draw right away instead of waiting for the next frame.
    this.renderNow();
  }

  // ---------------------------------------------------------------- theme and preferences

  /** Colours everything for the current theme and accent. Only material properties and uniforms change. */
  private readonly applyAppearance = (): void => {
    const { theme, accent, accentActive } = getAppearance();
    const palette = VIEWPORT_PALETTES[theme];
    this.container.style.background = palette.background;
    this.stage.setPalette(palette);
    for (const material of this.clay) {
      material.color.set(palette.clay);
      material.emissive.set(accent);
    }
    this.clayDim.color.set(palette.clayDim);
    this.wireDim.color.set(palette.wireDim);
    [palette.wire, accent, accentActive].forEach((color, i) => this.wireMaterials[i].color.set(color));
    [accent, accentActive].forEach((color, i) => {
      this.overlayMaterials[i].color.set(color);
      this.outlineMaterials[i].color.set(color);
    });
    this.editMaterials.setColors(palette, accent);
    this.boxElement.style.border = `1px solid ${accent}`;
    this.boxElement.style.background = `${accent}26`;
    this.invalidate();
  };

  private applyPreferences(preferences: Preferences): void {
    if (preferences === this.preferences) return;
    this.preferences = preferences;
    this.grid.setVisible(preferences.showGrid, preferences.showAxes);
    this.orbit.rotateSpeed = preferences.orbitSpeed;
    // A negative speed makes the orbit controls zoom the other way.
    this.orbit.zoomSpeed = BASE_ZOOM_SPEED * preferences.zoomSpeed * (preferences.invertZoom ? -1 : 1);
    if (this.camera.fov !== preferences.fieldOfView) {
      this.camera.fov = preferences.fieldOfView;
      this.camera.updateProjectionMatrix();
    }
    this.invalidate();
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

    const state = this.displayed(doc);
    const edit = state.edit;
    this.docScene.sync(app, state);
    this.updatePreview(app, doc);
    this.surfaces.sweep(app);
    this.surfaces.applyLighting(app, this.scene, this.ambient);

    // The gizmo: on the active object, or in edit mode on the selected elements.
    let target: Object3D | null = null;
    if (app.tool === 'select' || app.workspace === 'paint') {
      // No gizmo.
    } else if (edit) {
      const entry = this.entries.get(edit.objectId);
      const box = entry?.edit && entry.obj.visible ? selectionBox(entry.edit, edit) : null;
      if (entry && box) {
        box.getCenter(this.pivot.position);
        this.pivot.quaternion.identity();
        this.pivot.scale.setScalar(1);
        if (this.pivot.parent !== entry.group) entry.group.add(this.pivot);
        target = this.pivot;
      }
    } else if (app.tool !== 'move' && state.selection.length > 1) {
      // Several objects rotate and scale as a unit.
      if (this.placeGroupPivot(state.selection)) target = this.groupPivot;
    } else {
      const active = state.activeId ? this.entries.get(state.activeId) : undefined;
      if (active && active.obj.visible) target = active.group;
    }
    if (target && app.tool !== 'select' && app.workspace !== 'paint') {
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      this.gizmo.setMode(gizmoModes[app.tool]);
      // Edit mode works along the object's local axes.
      this.gizmo.setSpace(edit ? 'local' : 'world');
    } else if (this.gizmo.object) {
      this.gizmo.detach();
    }
    this.minecraft = isMinecraft(state);
    this.applySnapping();
  }

  /** Whether the displayed document is a Minecraft one: its gizmo snaps to the pixel grid. */
  private minecraft = false;
  private snapping: SnapSteps | null = null;
  private fine = { shift: false, ctrl: false };

  /**
   * Minecraft documents snap the gizmo: moving to whole model pixels (1/16 m; a quarter with Shift, a tenth
   * with Ctrl), rotating in 22.5 degree steps (finer with the same keys). Free documents never snap.
   */
  private applySnapping(): void {
    const next = this.minecraft ? snapSteps(this.fine.shift, this.fine.ctrl) : null;
    if (next?.translation === this.snapping?.translation && next?.rotation === this.snapping?.rotation) return;
    this.snapping = next;
    this.gizmo.setTranslationSnap(next ? next.translation : null);
    this.gizmo.setRotationSnap(next ? MathUtils.degToRad(next.rotation) : null);
  }

  private readonly onModifierKey = (event: KeyboardEvent): void => {
    const shift = event.shiftKey;
    const ctrl = event.ctrlKey || event.metaKey;
    if (shift === this.fine.shift && ctrl === this.fine.ctrl) return;
    this.fine = { shift, ctrl };
    this.applySnapping();
  };

  /**
   * Puts the group pivot, unrotated and unscaled, at the centre of the world-space bounding box of the
   * visible objects among `ids` (the box around their own boxes). False if none of them is visible.
   */
  private placeGroupPivot(ids: readonly string[]): boolean {
    const box = new Box3();
    const part = new Box3();
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || !entry.obj.visible) continue;
      const geometry = entry.solid.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      entry.group.updateWorldMatrix(true, false);
      box.union(part.copy(geometry.boundingBox!).applyMatrix4(entry.group.matrixWorld));
    }
    if (box.isEmpty()) return false;
    box.getCenter(this.groupPivot.position);
    this.groupPivot.quaternion.identity();
    this.groupPivot.scale.setScalar(1);
    if (!this.groupPivot.parent) this.scene.add(this.groupPivot);
    return true;
  }

  /** The transforms a group drag gives the objects it started with, for the gizmo's current state. */
  private groupDragTransforms(drag: Extract<Drag, { kind: 'group' }>): Map<string, Transform> {
    const { quaternion, scale } = this.groupPivot;
    const result = new Map<string, Transform>();
    for (const [id, t] of drag.start) {
      result.set(id, this.gizmo.mode === 'rotate' ? rotateAbout(t, drag.pivot, quaternion) : scaleAbout(t, drag.pivot, scale));
    }
    return result;
  }

  /** Commits a group drag as one `scene.set_transform` with every object that changed. */
  private commitGroupDrag(drag: Extract<Drag, { kind: 'group' }>): void {
    const state = this.docState();
    const items: { id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }[] = [];
    for (const [id, next] of this.groupDragTransforms(drag)) {
      const t = state?.objects[id] ? this.entries.get(id)?.obj.transform : undefined;
      if (!t) continue;
      const item: (typeof items)[number] = { id };
      if (!sameVec3(next.position, t.position)) item.position = next.position;
      if (!sameVec3(next.rotation, t.rotation)) item.rotation = next.rotation;
      if (!sameVec3(next.scale, t.scale)) item.scale = next.scale;
      if (item.position || item.rotation || item.scale) items.push(item);
    }
    if (items.length === 0) return this.resetTransforms();
    this.commitTransforms(items);
  }

  /**
   * Commits dragged transforms as one undo step. On animated objects the drag changed the pose at the
   * playhead: channels that have keys get a key on that frame with the resulting value, channels without
   * keys change the static transform (anim.set_pose with autoKey). Without animated objects it is a plain
   * scene.set_transform.
   */
  private commitTransforms(items: { id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }[]): void {
    const tracks = this.docState()?.animation?.tracks;
    const animated = tracks !== undefined && this.docId !== null && items.some((item) => Object.hasOwn(tracks, item.id));
    const run = animated ? execute('anim.set_pose', { frame: frameOf(this.docId!), items, autoKey: true }) : execute('scene.set_transform', { items });
    run.catch((error) => {
      console.error(error);
      this.resetTransforms();
    });
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
    // In the paint workspace the left button paints (paintView.ts) and never selects.
    if (event.button !== 0 || useApp.getState().workspace === 'paint') return;
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
    if (event.button !== 0 || this.gizmo.axis !== null || useApp.getState().workspace === 'paint') return;
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
    // Objects are picked where they are displayed (the animated pose), through the camera that displays them.
    this.viewCamera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.viewCamera);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    return hit ? (hit.object.userData.id as string) : null;
  }

  // ---------------------------------------------------------------- gizmo

  private readonly onGizmoDragging = (event: { value: unknown }): void => {
    const dragging = event.value === true;
    this.orbit.enabled = !dragging && !this.previewing;
    if (dragging) this.beginDrag();
    else this.endDrag();
  };

  private beginDrag(): void {
    // The pose is edited at the frame the playhead stands on.
    pause();
    const state = this.docState();
    if (this.gizmo.object === this.pivot) {
      const view = state?.edit ? this.entries.get(state.edit.objectId)?.edit : undefined;
      if (!view?.shown) return;
      view.beginPreview(selectedVertices(view.mesh, view.shown));
      this.drag = { kind: 'edit', view, pivot: this.pivot.position.clone() };
      return;
    }
    if (this.gizmo.object === this.groupPivot) {
      if (!state) return;
      const transforms = new Map<string, Transform>();
      // The transforms as displayed: at the playhead, animated objects are not where their static values put them.
      for (const id of state.selection) {
        const entry = this.entries.get(id);
        if (entry) transforms.set(id, entry.obj.transform);
      }
      this.drag = { kind: 'group', start: transforms, pivot: this.groupPivot.position.clone() };
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
    if (this.drag.kind === 'group') {
      for (const [id, t] of this.groupDragTransforms(this.drag)) {
        const entry = this.entries.get(id);
        if (entry) applyTransform(entry.group, t);
      }
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
    if (drag.kind === 'group') {
      this.commitGroupDrag(drag);
      return;
    }
    const state = this.docState();
    const active = state?.activeId ? this.entries.get(state.activeId) : undefined;
    const items: { id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }[] = [];
    if (state && active && state.objects[active.obj.id]) {
      const g = active.group;
      // Compared with what is displayed: the pose at the playhead.
      const t = active.obj.transform;
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
          if (!sameVec3(p, entry.obj.transform.position)) items.push({ id, position: p });
        }
      }
    }
    if (items.length > 0) this.commitTransforms(items);
    else this.resetTransforms();
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

  /**
   * The document a service call is about if that is NOT the one on screen, else null. Brings the scene up
   * to date first, so that a tab switch that has not been drawn yet counts.
   */
  private inBackground(doc: ViewDocument | undefined): ViewDocument | null {
    if (!doc) return null;
    this.syncIfNeeded();
    return doc.id === (this.docId ?? useApp.getState().activeDocId) ? null : doc;
  }

  /** The camera the user gets when they switch to that document's tab. */
  private rememberedCamera(id: string): CameraPose {
    return this.cameraByDoc.get(id) ?? this.getCamera();
  }

  private getCamera(doc?: ViewDocument): CameraPose {
    const background = this.inBackground(doc);
    if (background) return this.rememberedCamera(background.id);
    return { position: toVec3(this.camera.position), target: toVec3(this.orbit.target) };
  }

  private setCamera(pose: Partial<CameraPose>, doc?: ViewDocument): void {
    const background = this.inBackground(doc);
    if (background) {
      const current = this.rememberedCamera(background.id);
      const position = pose.position ?? current.position;
      const target = pose.target ?? current.target;
      // Camera and target must not coincide.
      const apart = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]) >= 1e-6;
      this.cameraByDoc.set(background.id, { position: apart ? position : [position[0], position[1], position[2] + 1], target });
      return;
    }
    if (pose.position) this.camera.position.set(...pose.position);
    if (pose.target) this.orbit.target.set(...pose.target);
    // Camera and target must not coincide.
    if (this.camera.position.distanceToSquared(this.orbit.target) < 1e-12) this.camera.position.z += 1;
    this.orbit.update();
    this.invalidate();
  }

  /** The camera that looks at `sphere` from `direction` with all of it in frame. */
  private framed(direction: Vector3, sphere: Sphere): CameraPose {
    const distance = fitDistance(sphere.radius, this.camera.fov, this.camera.aspect);
    return { position: sphere.center.clone().addScaledVector(direction, distance).toArray(), target: sphere.center.toArray() };
  }

  /**
   * Moves the camera of the document a call is about: the viewport camera, or for a document in the
   * background its remembered one. `pose` gets that camera's current viewing direction and the scene that
   * shows the document - for a document in the background one built just for this, to measure it.
   */
  private moveCamera(doc: ViewDocument | undefined, pose: (direction: Vector3, scene: DocScene, state: DocState | undefined) => CameraPose): void {
    const direction = (from: CameraPose) => {
      const d = new Vector3(...from.position).sub(new Vector3(...from.target));
      return d.lengthSq() > 0 ? d.normalize() : viewDirection('iso');
    };
    const background = this.inBackground(doc);
    if (!background) {
      this.syncIfNeeded();
      this.setCamera(pose(direction({ position: this.camera.position.toArray(), target: this.orbit.target.toArray() }), this.docScene, this.docState()));
      return;
    }
    const scene = new DocScene(this.looks);
    try {
      scene.sync(plainLook(useApp.getState()), background.state);
      this.cameraByDoc.set(background.id, pose(direction(this.rememberedCamera(background.id)), scene, background.state));
    } finally {
      scene.dispose();
    }
  }

  private setView(preset: ViewPreset, doc?: ViewDocument): void {
    this.moveCamera(doc, (_, scene) => this.framed(viewDirection(preset), scene.bounds([])));
  }

  /** Frames the objects; in edit mode the selected elements, if there are any. */
  private frame(ids: readonly string[], doc?: ViewDocument): void {
    this.moveCamera(doc, (direction, scene, state) => this.framed(direction, (state && scene.editSelectionBounds(state)) ?? scene.bounds(ids)));
  }

  /** The surroundings for a picture of a document in the background, in the current theme and preferences. */
  private backgroundStage(): Stage {
    const stage = (this.backStage ??= new Stage());
    stage.setPalette(VIEWPORT_PALETTES[getAppearance().theme]);
    const { showGrid, showAxes } = useApp.getState().preferences;
    stage.grid.setVisible(showGrid, showAxes);
    return stage;
  }

  /**
   * Renders a document to a PNG: one view, or several on a captioned sheet.
   *
   * The visible document is rendered from the scene on screen: everything changed for the picture (camera,
   * size, shading, which objects show, x-ray) is put back before this returns, in the same task as the
   * rendering, so the user never sees it and no state of the app is touched.
   *
   * A document in the background (`doc` is not the visible tab) gets a scene of its own for the picture,
   * built from its state on the background stage and thrown away afterwards; geometry, materials and
   * textures come from the shared caches. It shows that document's selection and edit mode and uses its
   * remembered camera for `current`. The scene on screen is not touched; it is only drawn again at the end,
   * because the picture is rendered through the same canvas.
   */
  private async screenshot(opts: ScreenshotOptions, doc?: ViewDocument): Promise<ScreenshotResult> {
    await this.ready;
    const width = Math.max(1, Math.round(opts.width));
    const height = Math.max(1, Math.round(opts.height));
    const views = screenshotViews(opts);
    const sheet = opts.views && opts.views.length > 0 ? sheetLayout(views.length, width, height) : null;
    const rects: Rect[] = sheet ? sheet.tiles.map((t) => t.image) : [{ x: 0, y: 0, width, height }];

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) throw new Error('Could not create a canvas for the screenshot');

    // Drawn apart from the scene on screen: a document in the background, or (`offscreen`) the state that came with the call.
    const apart = this.inBackground(doc) ?? (opts.offscreen && doc ? doc : null);
    const look = this.shotLook(opts, apart !== null);
    const encode = (info: Omit<ScreenshotResult, 'base64'>): ScreenshotResult => ({ base64: output.toDataURL('image/png').slice('data:image/png;base64,'.length), ...info });
    if (!apart) return encode(await this.renderShot(opts, output, context, sheet, views, rects, look, this.docScene, this.stage, null));
    const scene = new DocScene(this.looks);
    const stage = this.backgroundStage();
    stage.scene.add(scene.content);
    try {
      return encode(await this.renderShot(opts, output, context, sheet, views, rects, look, scene, stage, apart));
    } finally {
      stage.scene.remove(scene.content);
      scene.dispose();
    }
  }

  /** The look a picture is drawn in: the app's, with the picture's own shading. */
  private shotLook(opts: ScreenshotOptions, apart: boolean): () => AppState {
    return () => {
      const app = useApp.getState();
      const shading = opts.shading ?? app.shading;
      // The UV checker and the paint look belong to what the user does in their own tab; a document
      // drawn apart from the scene on screen is drawn as the modeling workspace shows it.
      const workspace = apart ? 'modeling' : app.workspace;
      return shading === app.shading && workspace === app.workspace ? app : { ...app, shading, workspace };
    };
  }

  /**
   * A run of single-view pictures of one document (the frames of a video), each drawn into the canvas
   * that comes with the call. The scene is built once and kept between the pictures, so a picture only
   * updates what changed since the last one; the scene on screen is never touched (it is drawn again
   * after every picture, because pictures go through the same canvas).
   */
  private sequence(doc: ViewDocument): ShotSequence {
    const scene = new DocScene(this.looks);
    let ended = false;
    return {
      shot: async (opts, state, target) => {
        await this.ready;
        if (ended) throw new Error('This run of pictures has ended');
        const output = target as HTMLCanvasElement;
        const width = Math.max(1, Math.round(opts.width));
        const height = Math.max(1, Math.round(opts.height));
        if (output.width !== width) output.width = width;
        if (output.height !== height) output.height = height;
        const context = output.getContext('2d');
        if (!context) throw new Error('Could not draw on the canvas of the video');
        const stage = this.backgroundStage();
        stage.scene.add(scene.content);
        try {
          const single = { ...opts, views: undefined };
          return await this.renderShot(single, output, context, null, screenshotViews(single), [{ x: 0, y: 0, width, height }], this.shotLook(opts, true), scene, stage, { id: doc.id, state });
        } finally {
          stage.scene.remove(scene.content);
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        scene.dispose();
      },
    };
  }

  /** The rendering of `screenshot`: `scene` on `stage` is the scene on screen, or for `background` one made for this picture. */
  private async renderShot(
    opts: ScreenshotOptions,
    output: HTMLCanvasElement,
    context: CanvasRenderingContext2D,
    sheet: ReturnType<typeof sheetLayout> | null,
    views: ReturnType<typeof screenshotViews>,
    rects: Rect[],
    look: () => AppState,
    scene: DocScene,
    stage: Stage,
    background: ViewDocument | null,
  ): Promise<Omit<ScreenshotResult, 'base64'>> {
    const { width, height } = output;
    /** Brings `scene` to the look of `app`. */
    const show = (app: AppState) => {
      if (background) {
        scene.sync(app, background.state);
        this.surfaces.applyLighting(app, stage.scene, stage.ambient);
      } else if (app === useApp.getState()) this.syncIfNeeded();
      else this.sync(app);
    };
    // Texture images are decoded asynchronously. Ask for them, step back to the user's look and wait,
    // so that materials show their maps in the picture.
    for (let attempt = 0; attempt < 3; attempt++) {
      const app = look();
      if (this.disposed || !this.initialised || app.shading !== 'material') break;
      show(app);
      const decoding = this.surfaces.settled();
      if (!background && app !== useApp.getState()) this.sync(useApp.getState());
      if (!decoding) break;
      await decoding;
    }
    if (this.disposed || !this.initialised) throw new Error('The 3D viewport is not available');

    const app = look();
    const overridden = !background && app !== useApp.getState();
    // `current`: the camera of the document the picture shows.
    // (A state of the visible document that is drawn apart from the screen still has the camera on screen.)
    const current: CameraPose =
      background && background.id !== this.docId
        ? this.rememberedCamera(background.id)
        : { position: this.camera.position.toArray(), target: this.orbit.target.toArray() };
    const hide = new Set(opts.hideIds);
    const only = opts.onlyIds ? new Set(opts.onlyIds) : null;
    const infos: ScreenshotViewInfo[] = [];
    const undo: (() => void)[] = [];
    const pixelRatio = this.renderer.getPixelRatio();
    const gizmoVisible = this.gizmoHelper.visible;
    this.gizmoHelper.visible = false;
    try {
      show(app);

      const shown: Entry[] = [];
      for (const [id, entry] of scene.entries) {
        if (!entry.obj.visible) continue;
        const show = !hide.has(id) && (!only || only.has(id));
        entry.group.visible = show;
        if (show) shown.push(entry);
      }
      if (opts.xray) scene.applyXray(shown, undo);

      const fitIds = typeof opts.fit === 'boolean' ? [] : opts.fit;
      // What presets and `fit` frame: the corners of the objects' boxes.
      let corners = scene.cornersOf(fitIds.length > 0 ? fitIds.map((id) => scene.entries.get(id)) : shown, shown);
      if (corners.length === 0) corners = [DEFAULT_SPHERE.center.clone()];
      const bounds = new Box3().setFromPoints(corners);
      // An empty scene or a single point still needs some room around it.
      if (bounds.getSize(new Vector3()).length() < 1e-6) corners = boxCorners(bounds.expandByScalar(corners.length > 1 ? 0.5 : DEFAULT_SPHERE.radius));
      const frame = { points: corners.map((c) => c.toArray()), centre: bounds.getCenter(new Vector3()) };
      const palette = VIEWPORT_PALETTES[getAppearance().theme];
      if (sheet) {
        context.fillStyle = palette.gridMajor;
        context.fillRect(0, 0, width, height);
      }
      this.renderer.setPixelRatio(1);
      views.forEach(({ name, view }, i) => {
        const rect = rects[i];
        const camera = new PerspectiveCamera(this.camera.fov, rect.width / rect.height);
        const target = this.poseShot(camera, view, opts.fit !== false, frame, current);
        // Each view is rendered at its own size, not scaled down from a larger picture.
        this.renderer.setSize(rect.width, rect.height, false);
        stage.draw(this.renderer, camera, target);
        // Read the canvas in the same task, before the browser presents (and may discard) the frame.
        context.drawImage(this.canvas, rect.x, rect.y, rect.width, rect.height);
        const cameraPosition = toVec3(camera.position);
        const cameraTarget = toVec3(target);
        const words = describeCamera(cameraPosition, cameraTarget);
        infos.push({ name, cameraPosition, cameraTarget, fov: camera.fov, ...words, rect });
        if (sheet) this.drawCaption(context, sheet.tiles[i].tile, sheet.labelHeight, sheet.fontSize, viewLabel(name, words), palette);
      });
    } finally {
      undo.forEach((restore) => restore());
      for (const entry of scene.entries.values()) entry.group.visible = entry.obj.visible;
      if (overridden) this.sync(useApp.getState());
      // Materials are shared by id: should the two documents have one in common (the same file opened
      // twice), it was last set up for the other document, and the scene on screen sets it up again.
      if (background) this.needsSync = true;
      this.gizmoHelper.visible = gizmoVisible;
      this.renderer.setPixelRatio(pixelRatio);
      // Draws what the user sees again, in this same task: the picture went through the visible canvas.
      this.resize();
    }
    return { views: infos, width, height, backend: this.backend ?? 'webgl2' };
  }

  /**
   * Places a screenshot camera for `view` and returns the point it looks at. Presets always frame
   * `frame`; the document's camera (`current`) and a given camera keep their direction and frame it if `fit` is set.
   */
  private poseShot(camera: PerspectiveCamera, view: ScreenshotView, fit: boolean, frame: { points: Vec3[]; centre: Vector3 }, current: CameraPose): Vector3 {
    const target = new Vector3();
    if (view === 'current') {
      camera.position.set(...current.position);
      target.set(...current.target);
    } else if (typeof view !== 'string') {
      camera.position.set(...view.position);
      target.set(...view.target);
      // Camera and target must not coincide.
      if (camera.position.distanceToSquared(target) < 1e-12) camera.position.z += 1;
      if (view.fov !== undefined) camera.fov = view.fov;
    }
    const preset = typeof view === 'string' && view !== 'current' ? view : null;
    if (preset || fit) {
      const direction = preset ? viewDirection(preset) : camera.position.clone().sub(target).normalize();
      target.copy(frame.centre);
      camera.position.copy(target).addScaledVector(direction, fitShot(frame.points, target.toArray(), direction.toArray(), camera.fov, camera.aspect));
    }
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    return target;
  }

  /** The caption strip at the top of a sheet tile; the text shrinks to fit the tile's width. */
  private drawCaption(
    context: CanvasRenderingContext2D,
    tile: Rect,
    labelHeight: number,
    fontSize: number,
    text: string,
    palette: ViewportPalette,
  ): void {
    const padding = 8;
    const font = (size: number) => `600 ${size}px "Segoe UI", system-ui, sans-serif`;
    context.save();
    context.beginPath();
    context.rect(tile.x, tile.y, tile.width, labelHeight);
    context.clip();
    context.fillStyle = palette.background;
    context.fillRect(tile.x, tile.y, tile.width, labelHeight);
    context.font = font(fontSize);
    const available = tile.width - 2 * padding;
    const needed = context.measureText(text).width;
    if (needed > available) context.font = font(Math.max(8, Math.floor((fontSize * available) / needed)));
    context.fillStyle = palette.caption;
    context.textAlign = 'left';
    context.textBaseline = 'middle';
    context.fillText(text, tile.x + padding, tile.y + labelHeight / 2 + 1);
    context.restore();
  }
}
