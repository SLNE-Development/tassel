// Cuboid elements (see `Cuboid` in types.ts): their derived polygon mesh and pure editing helpers.
import { cuboidFaces } from '../types';
import type { Cuboid, CuboidFace, CuboidFaceName, DocState, PolyMesh, SceneObject, Vec3 } from '../types';
import { PX, addVec, tidy, worldToModel } from './space';

export const DEFAULT_UV_SIZE: readonly [number, number] = [16, 16];

export type Uv = readonly [number, number, number, number];

/** The UV size of a document (its texture_size), [16, 16] for documents without Java settings. */
export function uvSize(state: Pick<DocState, 'java'>): readonly [number, number] {
  return state.java?.textureSize ?? DEFAULT_UV_SIZE;
}

export function blankFace(uv: Uv = [0, 0, 16, 16], texture: string | null = null): CuboidFace {
  return { enabled: true, texture, uv, rotation: 0, tintIndex: null, cullface: null };
}

/** Width and height in px of a face of a box of the given size (as its texture sees it). */
export function faceDimensions(size: Readonly<Vec3>, face: CuboidFaceName): [number, number] {
  switch (face) {
    case 'north':
    case 'south':
      return [size[0], size[1]];
    case 'east':
    case 'west':
      return [size[2], size[1]];
    case 'up':
    case 'down':
      return [size[0], size[2]];
  }
}

export function cuboidSize(c: Pick<Cuboid, 'from' | 'to'>): Vec3 {
  return [Math.abs(c.to[0] - c.from[0]), Math.abs(c.to[1] - c.from[1]), Math.abs(c.to[2] - c.from[2])];
}

/**
 * Auto UV: every face's UV rectangle gets the face's size (1 model px = 1 UV unit, at most the UV size),
 * keeping its top-left corner where it is but moved back inside the UV area. Mirroring is kept.
 */
export function autoUv(cuboid: Cuboid, size: readonly [number, number] = DEFAULT_UV_SIZE, only?: readonly CuboidFaceName[]): Cuboid {
  const dims = cuboidSize(cuboid);
  const faces = { ...cuboid.faces };
  for (const name of only ?? cuboidFaces) {
    const face = faces[name];
    const [w0, h0] = faceDimensions(dims, name);
    // Faces turned by 90 or 270 degrees show the texture sideways.
    const [w, h] = face.rotation % 180 === 0 ? [w0, h0] : [h0, w0];
    const fw = Math.min(w, size[0]);
    const fh = Math.min(h, size[1]);
    const mirrorX = face.uv[2] < face.uv[0];
    const mirrorY = face.uv[3] < face.uv[1];
    const x = clamp(Math.min(face.uv[0], face.uv[2]), 0, size[0] - fw);
    const y = clamp(Math.min(face.uv[1], face.uv[3]), 0, size[1] - fh);
    const [x1, x2] = mirrorX ? [x + fw, x] : [x, x + fw];
    const [y1, y2] = mirrorY ? [y + fh, y] : [y, y + fh];
    faces[name] = { ...face, uv: [tidy(x1), tidy(y1), tidy(x2), tidy(y2)] };
  }
  return { ...cuboid, faces };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A new cuboid between two local corners (px, relative to the origin) with auto UV from the top left. */
export function createCuboid(from: Readonly<Vec3>, to: Readonly<Vec3>, texture: string | null, size: readonly [number, number] = DEFAULT_UV_SIZE): Cuboid {
  const faces = Object.fromEntries(cuboidFaces.map((name) => [name, blankFace([0, 0, 0, 0], texture)])) as Record<CuboidFaceName, CuboidFace>;
  const box: Cuboid = {
    from: [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])],
    to: [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])],
    inflate: 0,
    rescale: false,
    shade: true,
    lightEmission: 0,
    shadeDirectionOverride: null,
    locked: false,
    export: true,
    color: 0,
    faces,
  };
  return autoUv(box, size);
}

/**
 * Face corners as [top-left, top-right, bottom-right, bottom-left] of the face's texture, seen from outside.
 * Each entry picks min (0) or max (1) per axis. Conventions as in Minecraft: side faces have +Y up; the up
 * face has north (-Z) at the top of its texture and the down face south (+Z).
 */
const CORNERS: Record<CuboidFaceName, readonly (readonly [0 | 1, 0 | 1, 0 | 1])[]> = {
  north: [[1, 1, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0]],
  south: [[0, 1, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1]],
  east: [[1, 1, 1], [1, 1, 0], [1, 0, 0], [1, 0, 1]],
  west: [[0, 1, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0]],
  up: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
  down: [[0, 0, 1], [1, 0, 1], [1, 0, 0], [0, 0, 0]],
};

/** Index of the face in a cuboid's mesh: faces are always all six, in `cuboidFaces` order. */
export const meshFaceIndex = (face: CuboidFaceName): number => cuboidFaces.indexOf(face);

/** UV corners of a face as [TL, TR, BR, BL] of the face, after its rotation. In UV px (y down). */
export function faceUvCorners(face: CuboidFace): [number, number][] {
  const [x1, y1, x2, y2] = face.uv;
  const corners: [number, number][] = [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
  // Rotating the texture clockwise by 90 degrees puts its bottom-left corner on the face's top-left corner.
  const shift = face.rotation / 90;
  return corners.map((_, i) => corners[(i - shift + 4) % 4]);
}

/**
 * The cuboid as a polygon mesh in the object's local space (meters, origin = pivot): six quads in
 * `cuboidFaces` order (also disabled ones, which the viewport leaves out), inflate applied, with UVs
 * normalised by the document's UV size (v up).
 */
export function cuboidMesh(cuboid: Cuboid, size: readonly [number, number] = DEFAULT_UV_SIZE): PolyMesh {
  const lo = cuboid.from.map((v, i) => Math.min(v, cuboid.to[i]) - cuboid.inflate);
  const hi = cuboid.from.map((v, i) => Math.max(v, cuboid.to[i]) + cuboid.inflate);
  const positions: number[] = [];
  const faces: number[][] = [];
  const uvs: number[][] = [];
  for (const name of cuboidFaces) {
    const base = positions.length / 3;
    for (const pick of CORNERS[name]) positions.push(...pick.map((p, axis) => (p ? hi[axis] : lo[axis]) / PX));
    // TL, TR, BR, BL is clockwise seen from outside; the mesh wants counter-clockwise: TL, BL, BR, TR.
    const order = [0, 3, 2, 1];
    faces.push(order.map((i) => base + i));
    const uv = faceUvCorners(cuboid.faces[name]);
    uvs.push(order.flatMap((i) => [uv[i][0] / size[0], 1 - uv[i][1] / size[1]]));
  }
  return { positions, faces, uvs };
}

/** Model-space from / to / origin of a cuboid object, in px (inflate not applied). */
export function modelBox(obj: Pick<SceneObject, 'transform'> & { cuboid: Cuboid }): { from: Vec3; to: Vec3; origin: Vec3 } {
  const origin = worldToModel(obj.transform.position);
  return { from: addVec(origin, obj.cuboid.from).map(tidy) as Vec3, to: addVec(origin, obj.cuboid.to).map(tidy) as Vec3, origin };
}

/** Bakes a non-unit scale into the cuboid's size (around the origin); a cuboid always keeps scale 1. */
function withUnitScale(obj: SceneObject & { cuboid: Cuboid }): SceneObject & { cuboid: Cuboid } {
  const s = obj.transform.scale;
  if (s[0] === 1 && s[1] === 1 && s[2] === 1) return obj;
  const a = obj.cuboid.from.map((v, i) => tidy(v * s[i]));
  const b = obj.cuboid.to.map((v, i) => tidy(v * s[i]));
  return {
    ...obj,
    transform: { ...obj.transform, scale: [1, 1, 1] },
    cuboid: {
      ...obj.cuboid,
      from: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
      to: [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
    },
  };
}

/** The mesh each cuboid was last derived into, per UV size; lets `syncCuboids` skip unchanged elements. */
const derived = new WeakMap<Cuboid, { size: readonly [number, number]; mesh: PolyMesh }>();

function meshFor(cuboid: Cuboid, size: readonly [number, number]): PolyMesh {
  const hit = derived.get(cuboid);
  if (hit && hit.size[0] === size[0] && hit.size[1] === size[1]) return hit.mesh;
  const mesh = cuboidMesh(cuboid, size);
  derived.set(cuboid, { size, mesh });
  return mesh;
}

/** A cuboid object brought in line with its cuboid: unit scale and the derived mesh. */
export function syncCuboidObject(obj: SceneObject, size: readonly [number, number]): SceneObject {
  if (!obj.cuboid) return obj;
  const scaled = withUnitScale(obj as SceneObject & { cuboid: Cuboid });
  const mesh = meshFor(scaled.cuboid, size);
  return scaled === obj && obj.mesh === mesh ? obj : { ...scaled, mesh, smooth: false, modifiers: [] };
}

/**
 * Keeps every cuboid element's mesh derived from its cuboid (and its scale at 1) after a change from
 * `before` to `after`. Only objects that changed are looked at, unless the UV size changed.
 */
export function syncCuboids(before: DocState, after: DocState): DocState {
  const texturesChanged = before.textures !== after.textures;
  if (before.objects === after.objects && before.java?.textureSize === after.java?.textureSize && !texturesChanged) return after;
  const size = uvSize(after);
  const all = before.java?.textureSize !== after.java?.textureSize || texturesChanged;
  let objects: Record<string, SceneObject> | null = null;
  for (const [id, obj] of Object.entries(after.objects)) {
    if (!obj.cuboid || (!all && Object.hasOwn(before.objects, id) && before.objects[id] === obj)) continue;
    // A removed texture leaves the faces that showed it without one.
    const synced = syncCuboidObject(texturesChanged ? withKnownFaceTextures(obj, after.textures) : obj, size);
    if (synced !== obj) (objects ??= { ...after.objects })[id] = synced;
  }
  const java = after.java && after.java.particle !== null && !Object.hasOwn(after.textures, after.java.particle) ? { ...after.java, particle: null } : after.java;
  const textures = texturesChanged && after.format === 'minecraft_java' ? withJavaRefs(after.textures) : after.textures;
  return objects || java !== after.java || textures !== after.textures
    ? { ...after, ...(objects ? { objects } : {}), ...(java ? { java } : {}), textures }
    : after;
}

/** Gives every texture of a Minecraft document a resource location: minecraft:block/<name>, variable "0", "1", ... */
export function withJavaRefs(textures: DocState['textures']): DocState['textures'] {
  const missing = Object.values(textures).filter((t) => !t.java);
  if (missing.length === 0) return textures;
  const taken = new Set(Object.values(textures).flatMap((t) => (t.java ? [t.java.key] : [])));
  const next = { ...textures };
  let n = 0;
  for (const texture of missing) {
    while (taken.has(String(n))) n++;
    taken.add(String(n));
    next[texture.id] = { ...texture, java: { namespace: 'minecraft', folder: 'block', key: String(n) } };
  }
  return next;
}

/** Face textures that are not in `textures` become null (e.g. after the texture was removed). */
export function withKnownFaceTextures(obj: SceneObject, textures: Readonly<Record<string, unknown>>): SceneObject {
  const cuboid = obj.cuboid;
  if (!cuboid) return obj;
  const stale = cuboidFaces.filter((f) => cuboid.faces[f].texture !== null && !Object.hasOwn(textures, cuboid.faces[f].texture!));
  if (stale.length === 0) return obj;
  const faces = { ...cuboid.faces };
  for (const f of stale) faces[f] = { ...faces[f], texture: null };
  return { ...obj, cuboid: { ...cuboid, faces } };
}
