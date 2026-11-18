import { PerspectiveCamera, Sphere, Vector3 } from 'three/webgpu';
import type { ViewPreset } from '../core/types';

/** Direction from the orbit target towards the camera. Y is up, "front" looks along -Z. */
const directions: Record<ViewPreset, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  // Slightly tilted so the view stays well-defined with a Y-up camera.
  top: [0, 1, 1e-4],
  bottom: [0, -1, 1e-4],
  iso: [1, 0.8, 1],
};

export function viewDirection(preset: ViewPreset): Vector3 {
  return new Vector3(...directions[preset]).normalize();
}

/** Used when there is nothing to frame (empty scene). */
export const DEFAULT_SPHERE = new Sphere(new Vector3(0, 0, 0), 2.5);

/** Camera distance at which a sphere of the given radius fits into the frame with a small margin. */
export function fitDistance(radius: number, fovDeg: number, aspect: number): number {
  const v = (fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * aspect);
  return (radius / Math.sin(Math.min(v, h))) * 1.15;
}

/** Places the camera so that it looks at the sphere from `direction` with the whole sphere in frame. */
export function placeCamera(camera: PerspectiveCamera, sphere: Sphere, direction: Vector3): void {
  const distance = fitDistance(sphere.radius, camera.fov, camera.aspect);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(sphere.center);
}

/** Near/far planes that work for any scene scale, derived from the distance to the point of interest. */
export function fitClipPlanes(camera: PerspectiveCamera, distance: number): void {
  const d = Math.max(distance, 1e-6);
  camera.near = d * 0.02;
  camera.far = d * 200;
  camera.updateProjectionMatrix();
}
