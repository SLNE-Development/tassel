import {
  AmbientLight,
  Color,
  DirectionalLight,
  DoubleSide,
  Euler,
  Group,
  Line2NodeMaterial,
  LineBasicMaterial,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { useApp } from '../../app/store';
import { isMinecraft } from '../../core/formats';
import { modelBox } from '../../core/minecraft/cuboid';
import { appliedTransform, effectiveSlot, isLeftHand, type DisplaySlot, type DisplayTransform } from '../../core/minecraft/display';
import type { Preferences } from '../../core/preferences';
import { activeDoc } from '../../core/state';
import type { AppState, DocState, Vec3 } from '../../core/types';
import { getMinecraftAssets, onMinecraftAssetsChange } from '../../mcassets';
import type { MinecraftAssets } from '../../mcassets/loader';
import { DocScene, releaseObjects, type SceneLooks } from '../docScene';
import { EditMaterials } from '../editMesh';
import { GeometryStore } from '../geometry';
import { loadSkin } from '../preview/controller';
import { BlockKit } from '../preview/terrain';
import { SurfaceMaterials } from '../surfaces';
import { buildBlocks, buildFox, buildFrame, buildGui, buildHolder, buildShelf, guiLayouts, type Built, type GuiKind } from './references';
import {
  FIRST_PERSON_FOV,
  MODEL_OFFSET,
  displayMatrix,
  firstPersonAnchor,
  frameAnchor,
  frameEntity,
  groundLift,
  groundMotion,
  guiAnchor,
  headAnchor,
  mul,
  shelfAnchor,
  shelfLift,
  thirdPersonHand,
  yRange,
  type ShelfSlot,
} from './slotMath';

// The 3D view of the Display workspace: the document's model posed by one display slot in a reference
// scene (a player holding it, an item frame, a GUI slot, ...). It has its own renderer and scene; the
// document's objects are drawn by a DocScene of its own, so the modelling viewport is not touched.

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export type SlotKind = 'third' | 'first' | 'head' | 'ground' | 'gui' | 'fixed' | 'shelf';

export function slotKind(slot: DisplaySlot): SlotKind {
  if (slot.startsWith('thirdperson')) return 'third';
  if (slot.startsWith('firstperson')) return 'first';
  if (slot === 'on_shelf') return 'shelf';
  return slot as 'head' | 'ground' | 'gui' | 'fixed';
}

/** What the HTML overlays need: a crosshair, and the slot to crop to (screen px, from the top left). */
export interface DisplayOverlay {
  crosshair: boolean;
  crop: { x: number; y: number; width: number; height: number } | null;
}

export interface DisplayViewCallbacks {
  /** The gizmo moved: the slot's new value (as stored, i.e. left hands un-mirrored). */
  onGizmo(slot: DisplaySlot, transform: DisplayTransform): void;
  onGizmoEnd(): void;
  onOverlay(overlay: DisplayOverlay): void;
}

type ViewPrefs = Pick<
  Preferences,
  | 'displaySlot'
  | 'displayThirdPerson'
  | 'displayHandAngle'
  | 'displayHeadAngle'
  | 'displayFirstPerson'
  | 'displayGround'
  | 'displayGroundAnimation'
  | 'displayFrame'
  | 'displayShelf'
  | 'displayShelfAlign'
  | 'displayGui'
  | 'previewSkin'
>;

const SKY = '#8fb3ea';

/**
 * The game's vertical field of view on a 16:9 window. A narrower view widens it so that everything the
 * game shows left and right of the crosshair stays in the picture.
 */
function firstPersonFov(aspect: number): number {
  const wide = 16 / 9;
  if (aspect >= wide) return FIRST_PERSON_FOV;
  const half = Math.atan(Math.tan(((FIRST_PERSON_FOV / 2) * Math.PI) / 180) * (wide / aspect));
  return (half * 2 * 180) / Math.PI;
}
const GUI_BACKGROUND = '#262626';
const EYE_HEIGHT = 1.62;

/** The reference scene a set of view options needs; equal keys share a scene. */
function sceneKey(p: ViewPrefs): string {
  switch (slotKind(p.displaySlot)) {
    case 'third':
    case 'head': {
      const left = isLeftHand(p.displaySlot);
      const raise = slotKind(p.displaySlot) === 'third' ? p.displayHandAngle : 0;
      return `entity:${p.displayThirdPerson}:${left ? 0 : raise}:${left ? raise : 0}:${slotKind(p.displaySlot) === 'head' ? p.displayHeadAngle : 0}:${p.previewSkin}`;
    }
    case 'first':
      return 'first';
    case 'ground':
      return `ground:${p.displayGround}`;
    case 'fixed':
      return `frame:${p.displayFrame}`;
    case 'shelf':
      return 'shelf';
    case 'gui':
      return `gui:${p.displayGui}`;
  }
}

export class DisplayView {
  private readonly renderer: WebGPURenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly scene = new Scene();
  private readonly perspective = new PerspectiveCamera(45, 1, 0.02, 200);
  private readonly ortho = new OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
  private readonly orbit: OrbitControls;
  private readonly orthoOrbit: OrbitControls;
  private readonly gizmo: TransformControls;
  private readonly gizmoHelper: Object3D;
  private readonly looks: SceneLooks;
  private readonly docScene: DocScene;
  /** anchor (slot's start, from slotMath) > proxy (display transform) > offset (model centring) > document. */
  private readonly anchor = new Group();
  private readonly proxy = new Object3D();
  private readonly offset = new Group();
  /** Handle for the move gizmo: in the anchor's axes, at the translation. */
  private readonly moveHandle = new Object3D();
  /** More copies of the model (crafting grid, shelf slots, inventory). */
  private readonly copies = new Group();
  private readonly reference = new Group();
  private readonly worldLights = new Group();
  private readonly guiLights = new Group();
  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeAssets: () => void;

  private assets: MinecraftAssets | null = getMinecraftAssets();
  private kit = new BlockKit(this.assets);
  private built: (Built & { key: string }) | null = null;
  private generation = 0;
  private docState: DocState | null = null;
  private copiesOf: DocState | null = null;
  private slot: DisplaySlot = 'thirdperson_righthand';
  private kind: SlotKind = 'third';
  private prefs: ViewPrefs | null = null;
  private dragging = false;
  private mode: GizmoMode = 'rotate';
  private gizmoVisible = true;
  private initialised = false;
  private disposed = false;
  private frameRequest = 0;
  private readonly cameraByKind = new Map<string, { position: Vector3; target: Vector3; zoom: number }>();
  private currentCamera: PerspectiveCamera | OrthographicCamera = this.perspective;
  private start = performance.now();
  private lastOverlay = '';

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: DisplayViewCallbacks,
  ) {
    this.renderer = new WebGPURenderer({ antialias: true, alpha: false });
    this.canvas = this.renderer.domElement as HTMLCanvasElement;
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%', outline: 'none' });
    container.appendChild(this.canvas);

    const clay = new MeshStandardMaterial({ color: '#b9b2a6', roughness: 0.9, side: DoubleSide });
    this.looks = {
      geometries: new GeometryStore(),
      surfaces: new SurfaceMaterials(() => this.invalidate()),
      clay: [clay, clay, clay],
      clayDim: clay,
      wireMaterials: [0, 1, 2].map(() => new LineBasicMaterial()),
      wireDim: new LineBasicMaterial(),
      overlayMaterials: [0, 1].map(() => new LineBasicMaterial()),
      outlineMaterials: [0, 1].map(() => new Line2NodeMaterial({ linewidth: 2, worldUnits: false })),
      editMaterials: new EditMaterials(),
    };
    this.docScene = new DocScene(this.looks);

    this.anchor.matrixAutoUpdate = false;
    this.offset.matrixAutoUpdate = false;
    this.offset.matrix.copy(MODEL_OFFSET);
    this.offset.add(this.docScene.content);
    this.proxy.add(this.offset);
    this.anchor.add(this.proxy, this.moveHandle);
    this.scene.add(this.anchor, this.copies, this.reference, this.worldLights, this.guiLights);

    // Entities and blocks in the world: the game's two light directions from above, plus ambient.
    const sun = new DirectionalLight('#ffffff', 1.6);
    sun.position.set(0.2, 1, -0.7);
    const sky = new DirectionalLight('#ffffff', 1.6);
    sky.position.set(-0.2, 1, 0.7);
    this.worldLights.add(sun, sky, new AmbientLight('#ffffff', 1.3));

    this.orbit = new OrbitControls(this.perspective, this.canvas);
    this.orbit.addEventListener('change', this.invalidate);
    this.orthoOrbit = new OrbitControls(this.ortho, this.canvas);
    this.orthoOrbit.enableRotate = false;
    this.orthoOrbit.screenSpacePanning = true;
    this.orthoOrbit.mouseButtons = { LEFT: 2, MIDDLE: 1, RIGHT: 2 };
    this.orthoOrbit.addEventListener('change', this.onOrthoChange);
    this.orthoOrbit.enabled = false;

    this.gizmo = new TransformControls(this.perspective, this.canvas);
    this.gizmoHelper = this.gizmo.getHelper();
    this.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('change', this.invalidate);
    this.gizmo.addEventListener('objectChange', this.onGizmoChange);
    this.gizmo.addEventListener('dragging-changed', (event) => {
      this.dragging = (event as unknown as { value: boolean }).value;
      this.orbit.enabled = !this.dragging && this.kind !== 'first' && this.kind !== 'gui';
      this.orthoOrbit.enabled = !this.dragging && this.kind === 'gui';
      if (!this.dragging) {
        this.callbacks.onGizmoEnd();
        this.update();
      }
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.unsubscribe = useApp.subscribe(() => this.update());
    this.unsubscribeAssets = onMinecraftAssetsChange(() => {
      this.assets = getMinecraftAssets();
      this.kit.dispose();
      this.kit = new BlockKit(this.assets);
      this.disposeReference();
      this.update();
    });

    void this.renderer.init().then(() => {
      if (this.disposed) return;
      this.initialised = true;
      this.looks.surfaces.init(this.renderer);
      this.resize();
      this.update();
    });
  }

  setGizmoMode(mode: GizmoMode, visible: boolean): void {
    this.mode = mode;
    this.gizmoVisible = visible;
    this.attachGizmo();
    this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.unsubscribe();
    this.unsubscribeAssets();
    this.resizeObserver.disconnect();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.orthoOrbit.dispose();
    this.disposeReference();
    this.clearCopies();
    this.docScene.dispose();
    this.kit.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- State -------------------------------------------------------------------------------------------

  private update = (): void => {
    if (this.disposed) return;
    const app = useApp.getState();
    const doc = activeDoc(app);
    if (!doc || !isMinecraft(doc.state)) return;
    const prefs = app.preferences;
    this.prefs = prefs;
    this.slot = prefs.displaySlot;
    this.kind = slotKind(this.slot);
    if (doc.state !== this.docState) {
      this.docState = doc.state;
      this.syncDoc(app, doc.state);
    }
    this.ensureReference(prefs);
    if (this.cameraKey() !== this.lastCameraKey || !this.cameraReady) this.applyCamera();
    this.place();
    this.invalidate();
  };

  private syncDoc(app: AppState, state: DocState): void {
    // The model as it is, textured, without selection or edit overlays.
    const look: AppState = { ...app, shading: 'solid', workspace: 'modeling' };
    this.docScene.sync(look, { ...state, selection: [], activeId: null, edit: null });
  }

  /** The model's bounds in the document's world (from the elements' boxes; whole block when empty). */
  private modelBounds(): [Vector3, Vector3] {
    const state = this.docState;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const id of state?.order ?? []) {
      const obj = state!.objects[id];
      if (!obj.cuboid || !obj.visible) continue;
      const box = modelBox(obj as typeof obj & { cuboid: NonNullable<typeof obj.cuboid> });
      min.min(new Vector3((box.from[0] - 8) / 16, box.from[1] / 16, (box.from[2] - 8) / 16));
      max.max(new Vector3((box.to[0] - 8) / 16, box.to[1] / 16, (box.to[2] - 8) / 16));
    }
    if (min.x === Infinity) return [new Vector3(-0.5, 0, -0.5), new Vector3(0.5, 1, 0.5)];
    return [min, max];
  }

  private transform(): DisplayTransform {
    return effectiveSlot(this.docState?.java?.display, this.slot).transform;
  }

  // ---- Placement ---------------------------------------------------------------------------------------

  /** The slot's start for every copy of the model; the first is the one the gizmo edits. */
  private anchors(display: Matrix4): Matrix4[] {
    const p = this.prefs!;
    const left = isLeftHand(this.slot);
    const [min, max] = this.modelBounds();
    const model = mul(display.clone(), MODEL_OFFSET);
    switch (this.kind) {
      case 'third':
        return [thirdPersonHand(p.displayThirdPerson, left, p.displayHandAngle)];
      case 'head':
        return [headAnchor(p.displayThirdPerson, p.displayHeadAngle)];
      case 'first':
        return [mul(new Matrix4().makeTranslation(0, EYE_HEIGHT, 0), firstPersonAnchor(p.displayFirstPerson, left))];
      case 'ground': {
        const { bob, spin } = groundMotion((performance.now() - this.start) / 1000, p.displayGroundAnimation);
        const turn = new Matrix4().makeRotationY((spin * Math.PI) / 180);
        const [lo] = yRange(mul(turn.clone(), model), min, max);
        return [mul(new Matrix4().makeTranslation(0, groundLift(lo, bob), 0), turn)];
      }
      case 'fixed':
        return [frameAnchor(p.displayFrame)];
      case 'shelf': {
        const slots: ShelfSlot[] = p.displayShelf === 'all' ? ['center', 'left', 'right'] : [p.displayShelf];
        return slots.map((s) => {
          const at = shelfAnchor(s);
          const [lo, hi] = yRange(mul(at.clone(), model), min, max);
          return mul(new Matrix4().makeTranslation(0, shelfLift(lo, hi, p.displayShelfAlign), 0), at);
        });
      }
      case 'gui':
        return guiLayouts[p.displayGui].slots.map(([x, y]) => guiAnchor(x + 8, -(y + 8)));
    }
  }

  private place(): void {
    if (!this.prefs || !this.docState) return;
    const left = isLeftHand(this.slot);
    const value = this.transform();
    const display = displayMatrix(value, left);
    const anchors = this.anchors(display);
    this.anchor.matrix.copy(anchors[0]);
    this.anchor.matrixWorldNeedsUpdate = true;
    if (!this.dragging) {
      const applied = appliedTransform(value, left);
      this.proxy.position.set(applied.translation[0] / 16, applied.translation[1] / 16, applied.translation[2] / 16);
      this.proxy.rotation.set(...(applied.rotation.map((a) => (a * Math.PI) / 180) as Vec3), 'XYZ');
      this.proxy.scale.set(...applied.scale);
      this.moveHandle.position.copy(this.proxy.position);
    }
    this.placeCopies(anchors.slice(1), display);
    const gui = this.kind === 'gui';
    this.worldLights.visible = !gui;
    this.guiLights.visible = gui;
    if (gui) this.setGuiLight(this.docState.java?.guiLight === 'front' ? 'front' : 'side');
    this.attachGizmo();
  }

  private clearCopies(): void {
    for (const child of [...this.copies.children]) {
      releaseObjects(child);
      this.copies.remove(child);
    }
  }

  private placeCopies(anchors: Matrix4[], display: Matrix4): void {
    if (this.copiesOf !== this.docState || this.copies.children.length !== anchors.length) {
      this.clearCopies();
      for (let i = 0; i < anchors.length; i++) {
        const copy = new Group();
        copy.matrixAutoUpdate = false;
        // Shares geometry and materials with the document's scene.
        copy.add(this.docScene.content.clone());
        this.copies.add(copy);
      }
      this.copiesOf = this.docState;
    }
    anchors.forEach((anchor, i) => {
      const copy = this.copies.children[i];
      copy.matrix.copy(mul(anchor.clone(), display, MODEL_OFFSET));
      copy.matrixWorldNeedsUpdate = true;
    });
  }

  private setGuiLight(light: 'side' | 'front'): void {
    const key = `${light}`;
    if (this.guiLights.userData.key === key) return;
    this.guiLights.userData.key = key;
    this.guiLights.clear();
    if (light === 'front') {
      // Flat items: lit straight from the viewer.
      const front = new DirectionalLight('#ffffff', 1.2);
      front.position.set(0, 0, 1);
      this.guiLights.add(front, new AmbientLight('#ffffff', 1.9));
    } else {
      // Blocks in the GUI: top brightest, the left side lit more than the right.
      const top = new DirectionalLight('#ffffff', 2.0);
      top.position.set(-0.45, 1, 0.55);
      const fill = new DirectionalLight('#ffffff', 0.7);
      fill.position.set(0.3, 0.2, 1);
      this.guiLights.add(top, fill, new AmbientLight('#ffffff', 1.1));
    }
  }

  // ---- Gizmo -------------------------------------------------------------------------------------------

  private attachGizmo(): void {
    const target = this.mode === 'translate' ? this.moveHandle : this.proxy;
    if (!this.gizmoVisible) {
      if (this.gizmo.object) this.gizmo.detach();
      this.gizmoHelper.visible = false;
      return;
    }
    this.gizmoHelper.visible = true;
    if (this.gizmo.object !== target) this.gizmo.attach(target);
    if (this.gizmo.getMode() !== this.mode) this.gizmo.setMode(this.mode);
    this.gizmo.setSpace('local');
    this.gizmo.size = this.kind === 'gui' ? 0.8 : 0.7;
    // Snapping like the element gizmo: whole pixels and 22.5 degree steps on the display grid.
    this.gizmo.setTranslationSnap(this.kind === 'gui' ? null : 1 / 64);
    this.gizmo.setRotationSnap((Math.PI / 180) * 1);
    this.gizmo.setScaleSnap(0.01);
  }

  private onGizmoChange = (): void => {
    if (!this.dragging) return;
    if (this.mode === 'translate') this.proxy.position.copy(this.moveHandle.position);
    const r = new Euler().setFromQuaternion(this.proxy.quaternion, 'XYZ');
    const round = (n: number, k: number) => Math.round(n * k) / k;
    const applied: DisplayTransform = {
      rotation: [r.x, r.y, r.z].map((a) => round((a * 180) / Math.PI, 100)) as Vec3,
      translation: this.proxy.position.toArray().map((v) => round(v * 16, 100)) as Vec3,
      scale: this.proxy.scale.toArray().map((v) => round(v, 1000)) as Vec3,
    };
    // Left hands show mirrored values: mirroring again gives what is stored.
    this.callbacks.onGizmo(this.slot, appliedTransform(applied, isLeftHand(this.slot)));
  };

  // ---- Reference scenes --------------------------------------------------------------------------------

  private disposeReference(): void {
    this.generation++;
    if (!this.built) return;
    releaseObjects(this.built.group);
    this.reference.remove(this.built.group);
    this.built.dispose();
    this.built = null;
  }

  private ensureReference(prefs: ViewPrefs): void {
    const key = sceneKey(prefs);
    if (this.built?.key === key || this.pendingKey === key) return;
    this.pendingKey = key;
    const generation = ++this.generation;
    void this.buildReference(prefs).then(
      (built) => {
        if (this.disposed || generation !== this.generation) return built.dispose();
        this.disposeReference();
        this.generation = generation;
        this.pendingKey = null;
        this.built = { ...built, key };
        this.reference.add(built.group);
        this.invalidate();
      },
      (error) => console.error('Display reference scene could not be built', error),
    );
  }

  private pendingKey: string | null = null;

  private async buildReference(p: ViewPrefs): Promise<Built> {
    const parts: Built[] = [];
    const kind = slotKind(p.displaySlot);
    const assets = this.assets;
    const floor = (y: number, radius: number) => {
      const blocks: { name: 'grass_block'; at: [number, number, number] }[] = [];
      for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) blocks.push({ name: 'grass_block', at: [x - 0.5, y, z - 0.5] });
      return blocks;
    };
    let background = SKY;
    switch (kind) {
      case 'third':
      case 'head': {
        const left = isLeftHand(p.displaySlot);
        const raise = kind === 'third' ? p.displayHandAngle : 0;
        const skin = p.displayThirdPerson === 'player' ? await loadSkin(p.previewSkin, assets) : null;
        parts.push(
          await buildHolder(
            { holder: p.displayThirdPerson, raise: { right: left ? 0 : raise, left: left ? raise : 0 }, headPitch: kind === 'head' ? p.displayHeadAngle : 0, skin },
            assets,
          ),
        );
        parts.push(await buildBlocks(this.kit, floor(-1, 3)));
        break;
      }
      case 'first':
        parts.push(await buildBlocks(this.kit, floor(-1, 6)));
        break;
      case 'ground':
        parts.push(await buildBlocks(this.kit, floor(-1, 3)));
        if (p.displayGround === 'block') parts.push(await buildBlocks(this.kit, [{ name: 'grass_block', at: [-1.75, 0, -0.5] }]));
        else parts.push(buildFox(-1));
        break;
      case 'fixed': {
        const top = p.displayFrame === 'top' || p.displayFrame === 'top_invisible';
        parts.push(await buildBlocks(this.kit, floor(-1, 3)));
        if (!top) {
          const wall: { name: 'stone'; at: [number, number, number] }[] = [];
          for (let x = -1; x <= 1; x++) for (let y = 0; y < 2; y++) wall.push({ name: 'stone', at: [x - 0.5, y, -1.5] });
          parts.push(await buildBlocks(this.kit, wall));
        }
        parts.push(await buildFrame(p.displayFrame, frameEntity(p.displayFrame), assets));
        break;
      }
      case 'shelf':
        parts.push(await buildBlocks(this.kit, floor(-1, 3)));
        parts.push(await buildShelf(assets));
        break;
      case 'gui':
        background = GUI_BACKGROUND;
        parts.push(await buildGui(p.displayGui as GuiKind, assets));
        break;
    }
    (this.scene.background as Color | null) ?? (this.scene.background = new Color());
    (this.scene.background as Color).set(background);
    const group = new Group();
    for (const part of parts) group.add(part.group);
    return { group, dispose: () => parts.forEach((part) => part.dispose()) };
  }

  // ---- Cameras -----------------------------------------------------------------------------------------

  private cameraReady = false;

  /** Where the camera starts for a kind of slot (the user's orbit is kept per kind while the view lives). */
  private defaultCamera(): { position: Vector3; target: Vector3 } {
    const p = this.prefs!;
    const small = p.displayThirdPerson === 'armor_stand_small' || p.displayThirdPerson === 'baby_zombie' ? 0.55 : 1;
    switch (this.kind) {
      case 'third':
        return { target: new Vector3(0, 0.85 * small, 0), position: new Vector3(1.4 * small, 1.25 * small, 2.4 * small) };
      case 'head':
        return { target: new Vector3(0, 1.7 * small, 0), position: new Vector3(1.2 * small, 2.1 * small, 2.0 * small) };
      case 'ground':
        return { target: new Vector3(-0.4, 0.25, 0), position: new Vector3(0.9, 0.9, 1.9) };
      case 'fixed':
        return p.displayFrame.startsWith('top')
          ? { target: new Vector3(0, 0.1, 0), position: new Vector3(0.7, 1.7, 1.3) }
          : { target: new Vector3(0, 0.5, -0.4), position: new Vector3(0.9, 1.0, 2.0) };
      case 'shelf':
        return { target: new Vector3(0, 0.45, 0), position: new Vector3(0.9, 1.0, 2.3) };
      default:
        return { target: new Vector3(), position: new Vector3(0, 0, 1) };
    }
  }

  /** Slots that share a key share a camera (the user's orbit included). */
  private cameraKey(): string {
    const p = this.prefs!;
    if (this.kind === 'gui') return `gui:${p.displayGui}`;
    if (this.kind === 'fixed') return `fixed:${p.displayFrame.startsWith('top')}`;
    if (this.kind === 'third' || this.kind === 'head') return `${this.kind}:${p.displayThirdPerson}`;
    return this.kind;
  }

  private saveCamera(): void {
    if (!this.cameraReady) return;
    const camera = this.currentCamera;
    const orbit = camera === this.ortho ? this.orthoOrbit : this.orbit;
    this.cameraByKind.set(this.lastCameraKey, { position: camera.position.clone(), target: orbit.target.clone(), zoom: camera.zoom });
  }

  private lastCameraKey = '';

  private applyCamera(): void {
    if (!this.prefs) return;
    this.saveCamera();
    const key = this.cameraKey();
    this.lastCameraKey = key;
    this.cameraReady = true;
    const saved = this.cameraByKind.get(key);
    if (this.kind === 'gui') {
      this.currentCamera = this.ortho;
      const [w, h] = guiLayouts[this.prefs.displayGui].size;
      const target = saved?.target ?? new Vector3(w / 2, -h / 2, 0);
      this.ortho.position.set(target.x, target.y, 1000);
      this.ortho.zoom = saved?.zoom ?? 1;
      this.orthoOrbit.target.copy(target);
      this.orbit.enabled = false;
      this.orthoOrbit.enabled = true;
    } else if (this.kind === 'first') {
      this.currentCamera = this.perspective;
      this.perspective.position.set(0, EYE_HEIGHT, 0);
      this.perspective.lookAt(0, EYE_HEIGHT, -1);
      this.orbit.enabled = false;
      this.orthoOrbit.enabled = false;
    } else {
      this.currentCamera = this.perspective;
      const start = saved ?? this.defaultCamera();
      this.perspective.position.copy(start.position);
      this.orbit.target.copy(start.target);
      this.orbit.enabled = !this.dragging;
      this.orthoOrbit.enabled = false;
      this.orbit.update();
    }
    this.gizmo.camera = this.currentCamera;
    this.resize();
  }

  /** Resets the camera of the current slot to its start. */
  resetCamera(): void {
    this.cameraByKind.delete(this.cameraKey());
    this.cameraReady = false;
    this.lastCameraKey = '';
    this.applyCamera();
    this.invalidate();
  }

  private onOrthoChange = (): void => {
    this.fitOrtho();
    this.invalidate();
  };

  /** The GUI camera shows the screen (or for a single slot, three slots' worth) at the current zoom. */
  private fitOrtho(): void {
    if (!this.prefs) return;
    const { width, height } = this.size();
    const [w, h] = guiLayouts[this.prefs.displayGui].size;
    const span = this.prefs.displayGui === 'slot' ? 48 : Math.max(w, h) * 1.15;
    const aspect = width / Math.max(1, height);
    const halfH = (aspect >= w / h ? span * (h / Math.max(w, h)) : span / aspect) / 2;
    const half = this.prefs.displayGui === 'slot' ? span / 2 : halfH;
    const halfW = half * aspect;
    Object.assign(this.ortho, { left: -halfW, right: halfW, top: half, bottom: -half });
    this.ortho.updateProjectionMatrix();
  }

  private size(): { width: number; height: number } {
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight) };
  }

  private resize(): void {
    if (!this.initialised) return;
    const { width, height } = this.size();
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(width, height, false);
    this.perspective.aspect = width / height;
    this.perspective.fov = this.kind === 'first' ? firstPersonFov(width / height) : 45;
    this.perspective.updateProjectionMatrix();
    this.fitOrtho();
    this.invalidate();
  }

  // ---- Drawing -----------------------------------------------------------------------------------------

  readonly invalidate = (): void => {
    if (this.disposed || this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.draw();
    });
  };

  private draw(): void {
    if (!this.initialised || !this.prefs || !this.docState) return;
    const animate = this.kind === 'ground' && this.prefs.displayGroundAnimation;
    if (animate) this.place();
    this.renderer.render(this.scene, this.currentCamera);
    this.reportOverlay();
    if (animate) this.invalidate();
  }

  private reportOverlay(): void {
    let crop: DisplayOverlay['crop'] = null;
    if (this.kind === 'gui' && this.prefs!.displayGui === 'slot') {
      // The main slot's 16 x 16 px, projected to the screen.
      const [x, y] = guiLayouts.slot.slots[0];
      const a = new Vector3(x, -y, 0).project(this.ortho);
      const b = new Vector3(x + 16, -(y + 16), 0).project(this.ortho);
      const { width, height } = this.size();
      crop = { x: ((a.x + 1) / 2) * width, y: ((1 - a.y) / 2) * height, width: ((b.x - a.x) / 2) * width, height: ((a.y - b.y) / 2) * height };
    }
    const overlay: DisplayOverlay = { crosshair: this.kind === 'first', crop };
    const key = JSON.stringify(overlay);
    if (key === this.lastOverlay) return;
    this.lastOverlay = key;
    this.callbacks.onOverlay(overlay);
  }
}
