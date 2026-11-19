// Where the faces of a Minecraft model sit on a texture, in texture pixels: for the paint bucket's face /
// element modes, "clear unused texture space", painting on faces in the 3D view and mirror painting.
import type { MirrorMap, PixelRect } from '../pixelOps';
import { cuboidFaces, type CuboidFaceName, type DocState, type SceneObject, type Texture } from '../types';
import { faceUvCorners, modelBox, uvSize } from './cuboid';

/** Height of one frame of a texture: an animated texture is a strip of square frames. */
export const frameHeight = (texture: Pick<Texture, 'width' | 'height' | 'animation'>): number =>
  texture.animation && texture.height >= texture.width && texture.height % texture.width === 0 ? texture.width : texture.height;

export const frameCount = (texture: Pick<Texture, 'width' | 'height' | 'animation'>): number => Math.max(1, Math.round(texture.height / frameHeight(texture)));

/** A 2x2 matrix [a, b, c, d] = [[a, b], [c, d]] acting on positions relative to a rectangle's centre. */
type D4 = readonly [number, number, number, number];

export interface FaceRegion {
  readonly elementId: string;
  readonly face: CuboidFaceName;
  /** The face's UV rectangle in texture pixels (of the given frame); may be empty for a zero-size UV. */
  readonly rect: PixelRect;
  /** Face space (u right, v down as seen from outside, centred) to the rect's relative space. */
  readonly orient: D4;
}

const multiply = (m: D4, n: D4): D4 => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3]];
const transpose = (m: D4): D4 => [m[0], m[2], m[1], m[3]];

/** Splits a D4 matrix into the flips and swap of a MirrorMap (flips first, then the swap). */
export function toMirror(m: D4): Pick<MirrorMap, 'flipX' | 'flipY' | 'swap'> {
  if (m[1] === 0 && m[2] === 0) return { flipX: m[0] < 0, flipY: m[3] < 0, swap: false };
  // m = S * F with S the swap: F = S * m.
  return { flipX: m[2] < 0, flipY: m[1] < 0, swap: true };
}

/** The face's texture rectangle and orientation, for a texture of `width` x `height` pixels per frame. */
function faceRegion(obj: SceneObject, face: CuboidFaceName, uvScale: readonly [number, number], frameOffset: number): FaceRegion {
  const data = obj.cuboid!.faces[face];
  const corners = faceUvCorners(data).map(([x, y]) => [x * uvScale[0], y * uvScale[1]] as const);
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const x0 = Math.floor(Math.min(...xs) + 1e-6);
  const y0 = Math.floor(Math.min(...ys) + 1e-6);
  const x1 = Math.ceil(Math.max(...xs) - 1e-6);
  const y1 = Math.ceil(Math.max(...ys) - 1e-6);
  const rel = (c: readonly [number, number]) => [Math.sign(c[0] - (x0 + x1) / 2), Math.sign(c[1] - (y0 + y1) / 2)] as const;
  const [tl, tr, , bl] = corners.map(rel);
  // Images of the face's u and v axes (each corner difference is 0 or +-2 in sign units).
  const orient: D4 = [Math.sign(tr[0] - tl[0]), Math.sign(bl[0] - tl[0]), Math.sign(tr[1] - tl[1]), Math.sign(bl[1] - tl[1])];
  const degenerate = orient[0] * orient[3] - orient[1] * orient[2] === 0;
  return {
    elementId: obj.id,
    face,
    rect: { x: x0, y: y0 + frameOffset, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) },
    orient: degenerate ? [1, 0, 0, 1] : orient,
  };
}

/** UV units to texture pixels for a texture in this document. */
function uvScaleOf(state: Pick<DocState, 'java'>, texture: Texture): readonly [number, number] {
  const size = uvSize(state);
  return [texture.width / size[0], frameHeight(texture) / size[1]];
}

/**
 * Every enabled face of the model's elements that shows `texture` (limited to `elementIds` if given), with
 * its rectangle on the texture in pixels (in frame `frame` of an animated texture).
 */
export function faceRegions(state: DocState, textureId: string, opts: { elementIds?: readonly string[]; frame?: number } = {}): FaceRegion[] {
  const texture = Object.hasOwn(state.textures, textureId) ? state.textures[textureId] : undefined;
  if (!texture) return [];
  const scale = uvScaleOf(state, texture);
  const offset = (opts.frame ?? 0) * frameHeight(texture);
  const ids = opts.elementIds ?? state.order;
  const out: FaceRegion[] = [];
  for (const id of ids) {
    const obj = Object.hasOwn(state.objects, id) ? state.objects[id] : undefined;
    if (!obj?.cuboid) continue;
    for (const face of cuboidFaces) {
      const data = obj.cuboid.faces[face];
      if (data.enabled && data.texture === textureId) out.push(faceRegion(obj, face, scale, offset));
    }
  }
  return out;
}

const contains = (r: PixelRect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

/** The face regions that contain pixel (x, y); the active element's faces first. */
export function regionsAt(state: DocState, textureId: string, x: number, y: number, frame = 0): FaceRegion[] {
  const all = faceRegions(state, textureId, { frame }).filter((r) => contains(r.rect, x, y));
  return all.sort((a, b) => Number(b.elementId === state.activeId) - Number(a.elementId === state.activeId));
}

export const mirrorAxes = ['x', 'z'] as const;
export type MirrorAxis = (typeof mirrorAxes)[number];

/** How mirroring across the axis maps the faces: the partner face and the flip in face space. */
const mirrorFace: Record<MirrorAxis, Record<CuboidFaceName, { face: CuboidFaceName; m: D4 }>> = {
  // Seen from outside, every side face's horizontal direction is reversed by the mirror; the top and bottom
  // faces have X along u and Z along v.
  x: {
    north: { face: 'north', m: [-1, 0, 0, 1] },
    south: { face: 'south', m: [-1, 0, 0, 1] },
    east: { face: 'west', m: [-1, 0, 0, 1] },
    west: { face: 'east', m: [-1, 0, 0, 1] },
    up: { face: 'up', m: [-1, 0, 0, 1] },
    down: { face: 'down', m: [-1, 0, 0, 1] },
  },
  z: {
    north: { face: 'south', m: [-1, 0, 0, 1] },
    south: { face: 'north', m: [-1, 0, 0, 1] },
    east: { face: 'east', m: [-1, 0, 0, 1] },
    west: { face: 'west', m: [-1, 0, 0, 1] },
    up: { face: 'up', m: [1, 0, 0, -1] },
    down: { face: 'down', m: [1, 0, 0, -1] },
  },
};

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

/** The element that is the mirror image of `obj` across the model's centre plane of the axis, if there is one. */
function mirrorPartner(state: DocState, obj: SceneObject, axis: MirrorAxis): SceneObject | undefined {
  const i = axis === 'x' ? 0 : 2;
  const box = modelBox(obj as SceneObject & { cuboid: NonNullable<SceneObject['cuboid']> });
  for (const id of state.order) {
    const other = state.objects[id];
    if (!other?.cuboid) continue;
    const b = modelBox(other as SceneObject & { cuboid: NonNullable<SceneObject['cuboid']> });
    const ok = [0, 1, 2].every((k) => (k === i ? near(b.from[k], 16 - box.to[k]) && near(b.to[k], 16 - box.from[k]) : near(b.from[k], box.from[k]) && near(b.to[k], box.to[k])));
    if (ok) return other;
  }
  return undefined;
}

/**
 * Mirror painting on a Minecraft model: for every face showing `textureId`, where a stroke on it is mirrored
 * to. global: across the model's centre plane (x = 8 or z = 8) onto the mirror-image element (if the model
 * has one); local: across the element's own centre, onto its own faces. Both axes: also the combination.
 */
export function mirrorMaps(state: DocState, textureId: string, axes: readonly MirrorAxis[], mode: 'global' | 'local', frame = 0): MirrorMap[] {
  if (axes.length === 0) return [];
  const regions = faceRegions(state, textureId, { frame });
  const byFace = new Map(regions.map((r) => [`${r.elementId}/${r.face}`, r]));
  // Every combination of the chosen axes except "no mirror".
  const combos: MirrorAxis[][] = axes.length === 1 ? [[axes[0]]] : [['x'], ['z'], ['x', 'z']];
  const maps: MirrorMap[] = [];
  for (const source of regions) {
    if (source.rect.width === 0 || source.rect.height === 0) continue;
    const obj = state.objects[source.elementId];
    for (const combo of combos) {
      let element: SceneObject | undefined = obj;
      let face = source.face;
      let m: D4 = [1, 0, 0, 1];
      for (const axis of combo) {
        if (!element) break;
        element = mode === 'local' ? element : mirrorPartner(state, element, axis);
        const step = mirrorFace[axis][face];
        face = step.face;
        m = multiply(step.m, m);
      }
      const target = element && byFace.get(`${element.id}/${face}`);
      if (!target || target.rect.width === 0 || target.rect.height === 0) continue;
      // texture(source) -> face space -> mirrored face space -> texture(target)
      const total = multiply(target.orient, multiply(m, transpose(source.orient)));
      maps.push({ from: source.rect, to: target.rect, ...toMirror(total) });
    }
  }
  return maps;
}

/** 2D editor symmetry: the whole image (or one frame) mirrored across its vertical centre line. */
export function imageMirror(texture: Pick<Texture, 'width' | 'height' | 'animation'>, frame = 0): MirrorMap {
  const h = frameHeight(texture);
  const rect = { x: 0, y: frame * h, width: texture.width, height: h };
  return { from: rect, to: rect, flipX: true, flipY: false, swap: false };
}
