import { Euler, Matrix4, Vector3 } from 'three/webgpu';
import { appliedTransform, type DisplayTransform } from '../../core/minecraft/display';
import type { Vec3 as V3 } from '../../core/types';

// Where the game draws an item for each display slot, as matrices in the Display workspace's world:
// 1 unit = 1 block, y up, entities stand at the origin facing +Z (their right hand is on -X).
//
// The chains follow how the game renders: an entity's root transform, then the model part (arm or head),
// then the layer's fixed offsets, then the slot's display transform (`displayMatrix`), then the item model,
// whose 0..16 px box is centred on the origin. The numbers are the game's well-known renderer offsets;
// the reference scenes around them are built from vanilla dimensions, so the picture is close to the game
// but not a pixel-exact copy.

const DEG = Math.PI / 180;
const T = (x: number, y: number, z: number) => new Matrix4().makeTranslation(x, y, z);
const S = (x: number, y = x, z = x) => new Matrix4().makeScale(x, y, z);
const Rx = (deg: number) => new Matrix4().makeRotationX(deg * DEG);
const Ry = (deg: number) => new Matrix4().makeRotationY(deg * DEG);
const Rz = (deg: number) => new Matrix4().makeRotationZ(deg * DEG);
export const mul = (...matrices: Matrix4[]): Matrix4 => matrices.reduce((a, b) => a.multiply(b), new Matrix4());

/** Rotation in the order the game uses for display transforms (X, then Y, then Z: Rx * Ry * Rz). */
export const rotationXYZ = ([x, y, z]: readonly number[]) => new Matrix4().makeRotationFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'XYZ'));

/** A slot's display transform as the game applies it (left hands mirrored): translate, rotate, scale. */
export function displayMatrix(transform: DisplayTransform, leftHand: boolean): Matrix4 {
  const t = appliedTransform(transform, leftHand);
  return mul(T(t.translation[0] / 16, t.translation[1] / 16, t.translation[2] / 16), rotationXYZ(t.rotation), S(...t.scale));
}

/**
 * From the item's display space to the document's world: the model's 0..16 px box is moved to be centred
 * on the origin. The document draws model px (8, 0, 8) at its origin (core/minecraft/space.ts).
 */
export const MODEL_OFFSET = T(0, -0.5, 0);

// ---- Entities ---------------------------------------------------------------------------------------

export type Holder = 'player' | 'zombie' | 'baby_zombie' | 'armor_stand' | 'armor_stand_small';

/** Entity model space (y down, front -Z, px / 16) to the world, for an entity standing at the origin facing +Z. */
export function entityRoot(holder: Holder): Matrix4 {
  const scale = holder === 'player' ? 0.9375 : holder === 'armor_stand_small' ? 0.5 : 1;
  // The living-entity renderer: turn to face +Z, scale, flip into model space, lift by 1.501.
  return mul(Ry(180), S(scale), S(-1, -1, 1), T(0, -1.501, 0));
}

/** Babies: body parts at half size standing on the ground, the head at 3/4 size on the shoulders. */
export const BABY_BODY = mul(T(0, 0.75, 0), S(0.5));
export const BABY_HEAD = mul(T(0, 0.75, 0), S(0.75));

/** A model part's pose: move to its pivot (px), rotate Z, Y, X. */
export function partMatrix(pivot: readonly number[], rotation: readonly number[] = [0, 0, 0]): Matrix4 {
  return mul(T(pivot[0] / 16, pivot[1] / 16, pivot[2] / 16), Rz(rotation[2]), Ry(rotation[1]), Rx(rotation[0]));
}

const isStand = (holder: Holder) => holder === 'armor_stand' || holder === 'armor_stand_small';

/** Pivot and resting pose of an arm (degrees), with the arm raised forward by `raise`. */
export function armPose(holder: Holder, left: boolean, raise: number): { pivot: [number, number, number]; rotation: [number, number, number] } {
  const side = left ? 1 : -1;
  // Armor stands hold their arms a little away from the body by default.
  const outward = isStand(holder) ? (left ? -10 : 10) : 0;
  return { pivot: [side * 5, 2, 0], rotation: [-raise, 0, outward] };
}

/** Pivot of the head in model space. */
export const headPivot = (holder: Holder): [number, number, number] => (isStand(holder) ? [0, 1, 0] : [0, 0, 0]);

/** The hand of a third-person holder: where `thirdperson_*hand` display transforms start. */
export function thirdPersonHand(holder: Holder, left: boolean, raise: number): Matrix4 {
  const arm = armPose(holder, left, raise);
  return mul(
    entityRoot(holder),
    holder === 'baby_zombie' ? BABY_BODY : new Matrix4(),
    partMatrix(arm.pivot, arm.rotation),
    // The held-item layer: lay the item into the fist, pointing forward.
    Rx(-90),
    Ry(180),
    T((left ? -1 : 1) / 16, 0.125, -0.625),
  );
}

/** The head of a holder: where the `head` display transform starts (head pitch `pitch` in degrees). */
export function headAnchor(holder: Holder, pitch: number): Matrix4 {
  return mul(
    entityRoot(holder),
    holder === 'baby_zombie' ? BABY_HEAD : new Matrix4(),
    partMatrix(headPivot(holder), [pitch, 0, 0]),
    // The head layer for items that are not skulls.
    T(0, -0.25, 0),
    Ry(180),
    S(0.625, -0.625, -0.625),
  );
}

// ---- First person -------------------------------------------------------------------------------------

export type FirstPersonPose = 'normal' | 'bow' | 'crossbow' | 'horn' | 'eating';

/** Field of view of the first-person camera (the game's default, vertical). */
export const FIRST_PERSON_FOV = 70;

/**
 * Where `firstperson_*hand` starts, in camera space (camera at the origin looking down -Z). The hand
 * offset of the game, plus the pose's own turn: a fully drawn bow, a charged crossbow held up, food
 * held to the mouth. Tooting a horn uses the plain hand offset in first person.
 */
export function firstPersonAnchor(pose: FirstPersonPose, left: boolean): Matrix4 {
  const i = left ? -1 : 1;
  const hand = T(i * 0.56, -0.52, -0.72);
  switch (pose) {
    case 'bow':
      return mul(hand, T(i * -0.2785682, 0.18344387, 0.15731531), Rx(-13.935), Ry(i * 35.3), Rz(i * -9.785), T(0, 0, 0.04), S(1, 1, 1.2), Ry(-i * 45));
    case 'crossbow':
      return mul(hand, T(i * -0.641864, 0, 0), Ry(i * 10));
    case 'eating':
      return mul(T(i * 0.6, -0.5, 0), Ry(i * 90), Rx(10), Rz(i * 30), hand);
    default:
      return hand;
  }
}

// ---- Item frame, ground, shelf, GUI ---------------------------------------------------------------------

export type FrameKind = 'frame' | 'invisible' | 'top' | 'top_invisible';

/**
 * The item frame entity (block centre at y 0.5): on a wall facing +Z (the wall block is behind it at z -1)
 * or lying on the floor facing up.
 */
export function frameEntity(kind: FrameKind): Matrix4 {
  const top = kind === 'top' || kind === 'top_invisible';
  return mul(T(0, 0.5, 0), top ? Rx(-90) : new Matrix4(), Ry(180));
}

/** Where `fixed` starts: in front of the frame's back board (or of the wall, when invisible), at half size. */
export function frameAnchor(kind: FrameKind): Matrix4 {
  const invisible = kind === 'invisible' || kind === 'top_invisible';
  return mul(frameEntity(kind), T(0, 0, invisible ? 0.5 : 0.4375), S(0.5));
}

/** World y the dropped item's bounding box is lifted to: 1 px over the ground, plus the bob. */
export function groundLift(minY: number, bob: number): number {
  return -minY + 1 / 16 + bob;
}

/** The item entity's bob (0..0.2 blocks) and spin (degrees) at a time in seconds; the still pose is the middle of the bob. */
export function groundMotion(seconds: number, animate: boolean): { bob: number; spin: number } {
  if (!animate) return { bob: 0.1, spin: 0 };
  const ticks = seconds * 20;
  return { bob: Math.sin(ticks / 10) * 0.1 + 0.1, spin: (ticks / 20) * (180 / Math.PI) };
}

export type ShelfSlot = 'left' | 'center' | 'right';

/** Shelf slot centres along X (blocks), front of the shelf facing +Z. */
export const SHELF_SLOTS: Record<ShelfSlot, number> = { left: -5 / 16, center: 0, right: 5 / 16 };
/** The shelf's inner floor and ceiling (world y of a shelf block standing on the ground). */
export const SHELF_FLOOR = 4 / 16;
export const SHELF_CEILING = 12 / 16;
export const SHELF_ITEM_SCALE = 0.25;

/** Where `on_shelf` starts for one shelf slot, before the alignment lift. Items face out like in a frame. */
export function shelfAnchor(slot: ShelfSlot): Matrix4 {
  return mul(T(SHELF_SLOTS[slot], 0, 0), Ry(180), S(SHELF_ITEM_SCALE));
}

/** World y offset that puts the item's bounding box on the shelf floor, or under its ceiling. */
export function shelfLift(minY: number, maxY: number, align: 'top' | 'bottom'): number {
  return align === 'bottom' ? SHELF_FLOOR - minY : SHELF_CEILING - maxY;
}

/** GUI items: 16 GUI px per block, centred on the slot, model facing the viewer (+Z). In GUI px, y up. */
export function guiAnchor(x: number, y: number): Matrix4 {
  return mul(T(x, y, 0), S(16));
}

/** The 8 corners of an axis-aligned box. */
export function corners(min: Vector3, max: Vector3): Vector3[] {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => new Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
}

/** Lowest and highest y of a box (in the document's world) after a matrix. */
export function yRange(matrix: Matrix4, min: Vector3, max: Vector3): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const corner of corners(min, max)) {
    const y = corner.applyMatrix4(matrix).y;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return [lo, hi];
}

const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * An X-Y-Z rotation has two sets of angles; this picks the one nearer to `previous`, so that dragging the
 * gizmo a little changes the numbers a little.
 */
export function closestAngles([x, y, z]: V3, previous: Readonly<V3>): V3 {
  const candidates: V3[] = [
    [x, y, z],
    [x + 180, 180 - y, z + 180],
  ].map((c) => c.map(wrap180) as V3);
  const distance = (c: V3) => c.reduce((sum, a, i) => sum + Math.abs(wrap180(a - previous[i])), 0);
  return distance(candidates[0]) <= distance(candidates[1]) ? candidates[0] : candidates[1];
}
