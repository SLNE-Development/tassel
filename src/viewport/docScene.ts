import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineSegments,
  MathUtils,
  Mesh,
  Scene,
  type Object3D,
  Sphere,
  Vector3,
  type Line2NodeMaterial,
  type LineBasicMaterial,
  type MeshStandardMaterial,
  type PerspectiveCamera,
  type WebGPURenderer,
} from 'three/webgpu';
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js';
import { evaluateObject } from '../core/modifiers/evaluate';
import type { AppState, DocState, PolyMesh, SceneObject, Shading, Transform } from '../core/types';
import { EditView, selectedVertices, type EditMaterials } from './editMesh';
import { DEFAULT_SPHERE, fitClipPlanes } from './framing';
import type { GeometryStore, MeshGeometry } from './geometry';
import { GroundGrid } from './grid';
import type { SurfaceMaterials } from './surfaces';
import type { ViewportPalette } from './theme';

/** 0 = not selected, 1 = selected, 2 = active. */
export type Highlight = 0 | 1 | 2;

/** One document object in a three.js scene. */
export interface Entry {
  obj: SceneObject;
  geometry: MeshGeometry;
  /** Carries the object transform; the gizmo attaches to it. */
  group: Group;
  solid: Mesh;
  wire: LineSegments | null;
  outline: LineSegments2 | null;
  /** Thin lines along borders and creases, shown in x-ray screenshots only. Built on first use. */
  creases: LineSegments | null;
  /**
   * Set while the object is being edited: it then shows its base mesh with the edit overlays, and
   * `geometry` (the modifier result) is hidden and not kept up to date.
   */
  edit: EditView | null;
}

/**
 * What every scene draws its objects with. One set per viewport, shared by all its `DocScene`s:
 * geometry is cached by mesh identity, PBR materials and textures by document material / texture.
 */
export interface SceneLooks {
  geometries: GeometryStore;
  surfaces: SurfaceMaterials;
  /** Clay for [not selected, selected, active]. */
  clay: readonly MeshStandardMaterial[];
  /** Other objects while one is being edited. */
  clayDim: MeshStandardMaterial;
  /** Wireframe shading for [not selected, selected, active]. */
  wireMaterials: readonly LineBasicMaterial[];
  wireDim: LineBasicMaterial;
  /** Faint all-edges overlay on solid objects for [selected, active]. */
  overlayMaterials: readonly LineBasicMaterial[];
  outlineMaterials: readonly Line2NodeMaterial[];
  editMaterials: EditMaterials;
}

/** How much of a surface shows in an x-ray screenshot; low enough that several layers still let the innermost through. */
const XRAY_OPACITY = 0.3;

export function boxCorners(box: Box3): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
}

export function applyTransform(group: Group, t: Transform): void {
  group.position.set(...t.position);
  group.rotation.set(MathUtils.degToRad(t.rotation[0]), MathUtils.degToRad(t.rotation[1]), MathUtils.degToRad(t.rotation[2]), 'XYZ');
  group.scale.set(...t.scale);
}

/**
 * Tells the renderer that `root` and everything below it will not be drawn again. three keeps a render
 * object with GPU uniform buffers for every object it has drawn and frees it only when the object (or
 * its material) announces `dispose`; our materials are shared and live as long as the viewport, so
 * without this every object that leaves a scene would stay behind on the GPU.
 */
export function releaseObjects(root: Object3D): void {
  root.traverse((object) => object.dispatchEvent({ type: 'dispose' } as never));
}

/** Local-space bounding box of the selected elements, or null if nothing is selected. */
export function selectionBox(view: EditView, edit: NonNullable<DocState['edit']>): Box3 | null {
  const box = new Box3();
  const point = new Vector3();
  const count = view.vertexPositions.length / 3;
  for (const v of selectedVertices(view.mesh, edit)) {
    if (v < count) box.expandByPoint(point.fromArray(view.vertexPositions, v * 3));
  }
  return box.isEmpty() ? null : box;
}

/**
 * The objects of one document as three.js content: `sync` mirrors a `DocState` into `content`, diffing
 * by reference identity. The viewport keeps one for the visible document; a screenshot of a document in
 * the background builds a second one for the duration of the picture. Both draw from the same
 * `SceneLooks`, so a mesh or texture two scenes share exists once on the GPU.
 */
export class DocScene {
  /** Add this to a scene. */
  readonly content = new Group();
  readonly entries = new Map<string, Entry>();

  /** `onRemove` is called before an object leaves the scene (to detach what hangs on it). */
  constructor(
    private readonly looks: SceneLooks,
    private readonly onRemove: (entry: Entry) => void = () => {},
  ) {}

  /** Makes `content` show the objects of `state` in the look of `app`: its shading and workspace, the selection and edit mode of `state`. */
  sync(app: AppState, state: DocState): void {
    const { looks } = this;
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
          this.disposeEdit(entry);
          entry.edit = new EditView(obj.mesh, looks.editMaterials, looks.clay[0]);
          entry.group.add(entry.edit.group);
        }
        entry.edit.setSelection(edit);
        entry.edit.setLook(app.shading, edit.elementMode);
        entry.solid.visible = false;
        if (entry.wire) entry.wire.visible = false;
        if (entry.outline) entry.outline.visible = false;
        continue;
      }

      this.disposeEdit(entry);
      const mesh = evaluateObject(state, id).mesh;
      if (entry.geometry.mesh !== mesh || entry.geometry.smooth !== obj.smooth) this.swapGeometry(entry, mesh, obj.smooth);
      // No selection overlays in the paint workspace: they would lie on top of what is painted.
      const highlight: Highlight = app.workspace === 'paint' ? 0 : id === state.activeId ? 2 : selected.has(id) ? 1 : 0;
      const surface = looks.surfaces.pick(app, state, obj, entry.geometry.hasUvs);
      this.applyLook(entry, app.shading, highlight, edit !== null, surface);
    }
  }

  /** Empties the scene and gives back its geometry. */
  dispose(): void {
    for (const [id, entry] of this.entries) this.removeEntry(id, entry);
  }

  private createEntry(state: DocState, obj: SceneObject): Entry {
    const geometry = this.looks.geometries.acquire(evaluateObject(state, obj.id).mesh, obj.smooth);
    const group = new Group();
    applyTransform(group, obj.transform);
    const solid = new Mesh(geometry.solid, this.looks.clay[0]);
    solid.userData.id = obj.id;
    group.add(solid);
    this.content.add(group);
    const entry: Entry = { obj, geometry, group, solid, wire: null, outline: null, creases: null, edit: null };
    this.entries.set(obj.id, entry);
    return entry;
  }

  private disposeEdit(entry: Entry): void {
    if (!entry.edit) return;
    releaseObjects(entry.edit.group);
    entry.edit.dispose();
    entry.edit = null;
  }

  private removeEntry(id: string, entry: Entry): void {
    this.onRemove(entry);
    this.disposeEdit(entry);
    releaseObjects(entry.group);
    this.content.remove(entry.group);
    this.looks.geometries.release(entry.geometry);
    this.entries.delete(id);
  }

  private swapGeometry(entry: Entry, mesh: PolyMesh, smooth: boolean): void {
    const next = this.looks.geometries.acquire(mesh, smooth);
    this.looks.geometries.release(entry.geometry);
    entry.geometry = next;
    entry.solid.geometry = next.solid;
    // Edge objects are rebuilt lazily by applyLook.
    for (const lines of [entry.wire, entry.outline, entry.creases]) {
      if (!lines) continue;
      releaseObjects(lines);
      entry.group.remove(lines);
    }
    entry.wire = null;
    entry.outline = null;
    entry.creases = null;
  }

  /** `dim`: another object is being edited; this one steps back and shows no selection. */
  private applyLook(entry: Entry, shading: Shading, highlight: Highlight, dim: boolean, surface: MeshStandardMaterial | null): void {
    const { looks } = this;
    const wireframe = shading === 'wireframe';
    if (dim) highlight = 0;
    entry.solid.visible = !wireframe;
    // `surface`: the object's PBR material or the UV checker instead of the clay (see surfaces.ts).
    entry.solid.material = dim ? looks.clayDim : (surface ?? looks.clay[highlight]);

    // All edges: the object itself in wireframe shading, a faint overlay on selected solid objects.
    if (wireframe || highlight > 0) {
      const material = dim ? looks.wireDim : wireframe ? looks.wireMaterials[highlight] : looks.overlayMaterials[highlight - 1];
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
      const material = looks.outlineMaterials[highlight - 1];
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

  /**
   * The world-space corners of the bounding boxes of the visible objects in `list`, eight per object;
   * of those in `fallback` if there are none.
   */
  cornersOf(list: Iterable<Entry | undefined>, fallback: Iterable<Entry | undefined>): Vector3[] {
    const collect = (entries: Iterable<Entry | undefined>): Vector3[] => {
      const corners: Vector3[] = [];
      for (const entry of entries) {
        const local = entry?.edit ? entry.edit.box : entry?.geometry.solid.boundingBox;
        if (!entry || !entry.obj.visible || !local || local.isEmpty()) continue;
        entry.group.updateMatrix();
        for (const corner of boxCorners(local)) corners.push(corner.applyMatrix4(entry.group.matrix));
      }
      return corners;
    };
    const corners = collect(list);
    return corners.length > 0 ? corners : collect(fallback);
  }

  /** World-space bounding sphere of the visible objects among `ids` (all objects if empty). */
  bounds(ids: readonly string[]): Sphere {
    const corners = this.cornersOf(
      ids.map((id) => this.entries.get(id)),
      this.entries.values(),
    );
    if (corners.length === 0) return DEFAULT_SPHERE.clone();
    const sphere = new Box3().setFromPoints(corners).getBoundingSphere(new Sphere());
    if (!(sphere.radius > 1e-6)) sphere.radius = 1;
    return sphere;
  }

  /** World-space bounding sphere of the elements selected in edit mode; null in object mode or without a selection. */
  editSelectionBounds(state: DocState): Sphere | null {
    const edit = state.edit;
    const entry = edit ? this.entries.get(edit.objectId) : undefined;
    const box = edit && entry?.edit ? selectionBox(entry.edit, edit) : null;
    if (!entry || !box) return null;
    entry.group.updateMatrix();
    const sphere = box.applyMatrix4(entry.group.matrix).getBoundingSphere(new Sphere());
    // A single vertex still needs some room around it.
    if (!(sphere.radius > 1e-6)) sphere.radius = 0.5;
    return sphere;
  }

  /**
   * X-ray look for a screenshot: the surfaces of `shown` turn semi-transparent and stop writing depth,
   * so everything behind and inside them shows through, and thin lines along borders and creases keep
   * the shapes readable. Plain alpha blending and line primitives only, so it is the same on WebGPU and
   * WebGL2. `undo` receives what puts the scene (and the shared materials) back.
   */
  applyXray(shown: readonly Entry[], undo: (() => void)[]): void {
    const materials = new Set<MeshStandardMaterial>();
    for (const entry of shown) {
      if (entry.edit || !entry.solid.visible) continue;
      materials.add(entry.solid.material as MeshStandardMaterial);
      const creases = entry.geometry.creases;
      if (!creases) continue;
      // Kept with the object (hidden) rather than made for each picture: three holds GPU buffers per drawn object.
      if (!entry.creases) {
        entry.creases = new LineSegments(creases, this.looks.wireMaterials[0]);
        entry.group.add(entry.creases);
      }
      const lines = entry.creases;
      lines.visible = true;
      undo.push(() => (lines.visible = false));
    }
    for (const material of materials) {
      const { transparent, opacity, depthWrite } = material;
      Object.assign(material, { transparent: true, opacity: XRAY_OPACITY, depthWrite: false, needsUpdate: true });
      undo.push(() => Object.assign(material, { transparent, opacity, depthWrite, needsUpdate: true }));
    }
  }
}

/**
 * What surrounds the objects in a picture: background, ground grid with its fog, and the studio lights.
 * The viewport has one for what the user sees and a second one for pictures of documents in the
 * background, so that rendering those never touches the scene on screen.
 */
export class Stage {
  readonly scene = new Scene();
  readonly grid = new GroundGrid();
  /** Follows the camera, so every view direction is lit the same way. */
  readonly lightRig = new Group();
  /** Replaced by the environment in material shading (see `SurfaceMaterials.applyLighting`). */
  readonly ambient = new HemisphereLight('#e4e9f2', '#3a3632', 1.5);

  constructor() {
    this.scene.background = new Color();
    this.scene.fog = this.grid.fog;
    this.scene.add(this.grid.object, this.lightRig, this.ambient);
    // Soft studio lighting.
    const key = new DirectionalLight('#fff3e4', 2.4);
    key.position.set(-3, 5, 4);
    const fill = new DirectionalLight('#a9bfe6', 0.7);
    fill.position.set(5, -1, 2);
    this.lightRig.add(key, fill);
  }

  setPalette(palette: ViewportPalette): void {
    (this.scene.background as Color).set(palette.background);
    this.grid.setPalette(palette);
  }

  /** Renders the scene from `camera`, which looks at `target`. */
  draw(renderer: WebGPURenderer, camera: PerspectiveCamera, target: Vector3): void {
    const distance = camera.position.distanceTo(target);
    fitClipPlanes(camera, distance);
    this.grid.update(target, distance);
    this.lightRig.quaternion.copy(camera.quaternion);
    renderer.render(this.scene, camera);
  }

  dispose(): void {
    this.grid.dispose();
  }
}
