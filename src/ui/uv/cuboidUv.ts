// Pure geometry of the cuboid UV editor: a face's UV rectangle (in UV pixels) and how dragging changes it.

/** [x1, y1, x2, y2] as stored on a cuboid face: x1 > x2 or y1 > y2 means the texture is mirrored. */
export type UvRect = readonly [number, number, number, number];

/** The rectangle as position and size, always with positive size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Rounds away float noise like 0.30000000000000004. */
export const tidy = (n: number): number => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
};

export function uvToBox(uv: UvRect): Box {
  const [x1, y1, x2, y2] = uv;
  return { x: tidy(Math.min(x1, x2)), y: tidy(Math.min(y1, y2)), w: tidy(Math.abs(x2 - x1)), h: tidy(Math.abs(y2 - y1)) };
}

/** The UV rectangle of a box that is mirrored the same way as `like` is. */
export function boxToUv(box: Box, like: UvRect): UvRect {
  const mirrorX = like[2] < like[0];
  const mirrorY = like[3] < like[1];
  const [x1, x2] = mirrorX ? [box.x + box.w, box.x] : [box.x, box.x + box.w];
  const [y1, y2] = mirrorY ? [box.y + box.h, box.y] : [box.y, box.y + box.h];
  return [tidy(x1), tidy(y1), tidy(x2), tidy(y2)];
}

/** Grid step of a drag: whole UV pixels, a quarter with Shift, a tenth with Ctrl. */
export const snapStep = (shift: boolean, ctrl: boolean): number => (ctrl ? 0.1 : shift ? 0.25 : 1);

export const snap = (value: number, step: number): number => tidy(Math.round(value / step) * step);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The box after dragging `handle` by (dx, dy) UV pixels from `start`. Every edge that moves lands on the
 * snap grid and stays inside `size`; the box never gets negative size (an edge stops at the opposite one).
 */
export function dragBox(start: Box, handle: Handle, dx: number, dy: number, step: number, size: readonly [number, number]): Box {
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(snap(start.x + dx, step), 0, Math.max(0, size[0] - start.w)),
      y: clamp(snap(start.y + dy, step), 0, Math.max(0, size[1] - start.h)),
    };
  }
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes('w')) left = clamp(snap(left + dx, step), 0, right);
  if (handle.includes('e')) right = clamp(snap(right + dx, step), left, size[0]);
  if (handle.includes('n')) top = clamp(snap(top + dy, step), 0, bottom);
  if (handle.includes('s')) bottom = clamp(snap(bottom + dy, step), top, size[1]);
  return { x: tidy(left), y: tidy(top), w: tidy(right - left), h: tidy(bottom - top) };
}

/** Which edge of the rectangle the top of the texture lies on after a clockwise rotation. */
export const topEdge = (rotation: number): 'n' | 'e' | 's' | 'w' => (['n', 'e', 's', 'w'] as const)[(rotation / 90) % 4];
