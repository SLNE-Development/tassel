/** Gizmo snapping in Minecraft documents. */

export interface SnapSteps {
  /** Meters. */
  translation: number;
  /** Degrees. */
  rotation: number;
}

/** One model pixel in meters. */
const PIXEL = 1 / 16;

/**
 * Moving snaps to whole model pixels, rotating to 22.5 degrees. Shift makes the steps a quarter as big
 * (a quarter pixel, 5.625 degrees), Ctrl a tenth (a tenth of a pixel, 2.25 degrees); Ctrl wins over Shift.
 */
export function snapSteps(shift: boolean, ctrl: boolean): SnapSteps {
  const factor = ctrl ? 0.1 : shift ? 0.25 : 1;
  return { translation: PIXEL * factor, rotation: 22.5 * factor };
}
