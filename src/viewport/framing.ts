import { PerspectiveCamera, Sphere, Vector3 } from 'three/webgpu';
import { presetDirections } from '../core/screenshotViews';
import type { ViewPreset } from '../core/types';

/** Direction from the orbit target towards the camera; see `presetDirections` (Y is up, "front" looks along -Z). */
export function viewDirection(preset: ViewPreset): Vector3 {
  return new Vector3(...presetDirections[preset]).normalize();
}

/** Used when there is nothing to frame (empty scene). */
export const DEFAULT_SPHERE = new Sphere(new Vector3(0, 0, 0), 2.5);

/** Camera distance at which a sphere of the given radius fits into the frame with a small margin. */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const v = (fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * aspect);
  return (radius / Math.sin(Math.min(v, h))) * 1.15;
}

/** Near/far planes that work for any scene scale, derived from the distance to the point of interest. */
export function fitClipPlanes(camera: PerspectiveCamera, distance: number): void {
  const d = Math.max(distance, 1e-6);
  camera.near = d * 0.02;
  camera.far = d * 200;
  camera.updateProjectionMatrix();
}
