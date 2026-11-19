import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from './project';
import { defaultRenderSettings, discSolidAngle, mergeRenderSettings, parseRenderSettings, renderSettingsOf, renderSettingsSchema, resolveRenderCamera, sunDirection } from './render';
import { createDoc, emptyDocState } from './state';
import type { Vec3 } from './types';

const close = (a: readonly number[], b: readonly number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('render settings', () => {
  it('has valid defaults', () => {
    expect(renderSettingsSchema.parse(defaultRenderSettings)).toEqual(defaultRenderSettings);
    expect(renderSettingsOf(emptyDocState)).toBe(defaultRenderSettings);
  });

  it('merges a partial change and keeps untouched groups identical', () => {
    const next = mergeRenderSettings(defaultRenderSettings, { sun: { elevation: 20, azimuth: undefined }, output: { width: 640 } });
    expect(next.sun).toEqual({ ...defaultRenderSettings.sun, elevation: 20 });
    expect(next.output.width).toBe(640);
    expect(next.output.height).toBe(defaultRenderSettings.output.height);
    expect(next.environment).toBe(defaultRenderSettings.environment);
    expect(mergeRenderSettings(defaultRenderSettings, { sun: {} }).sun).toBe(defaultRenderSettings.sun);
  });

  it('reads stored settings leniently, field by field', () => {
    expect(parseRenderSettings(undefined)).toEqual(defaultRenderSettings);
    expect(parseRenderSettings('nonsense')).toEqual(defaultRenderSettings);
    const parsed = parseRenderSettings({
      environment: { preset: 'studio', intensity: -5, rotation: 'x' },
      sun: 7,
      output: { width: 99999, height: 512, samples: 64.5, format: 'bmp', future: true },
      unknownGroup: { a: 1 },
      __proto__: { polluted: true },
    });
    expect(parsed.environment).toEqual({ ...defaultRenderSettings.environment, preset: 'studio' });
    expect(parsed.sun).toEqual(defaultRenderSettings.sun);
    expect(parsed.output).toEqual({ ...defaultRenderSettings.output, height: 512 });
    expect(Object.keys(parsed)).toEqual(Object.keys(defaultRenderSettings));
    expect(renderSettingsSchema.safeParse(parsed).success).toBe(true);
    // An explicit camera is kept, a broken one is not.
    expect(parseRenderSettings({ camera: { view: { position: [1, 2, 3], target: [0, 0, 0] } } }).camera.view).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    expect(parseRenderSettings({ camera: { view: { position: [1, 2], target: [0, 0, 0] } } }).camera.view).toBe('current');
  });

  it('is saved with the project, and files without it load', () => {
    const plain = createDoc('A');
    expect(JSON.parse(serializeProject(plain))).not.toHaveProperty('render');
    expect(parseProject(serializeProject(plain)).state.render).toBeUndefined();

    const render = mergeRenderSettings(defaultRenderSettings, { environment: { preset: 'sunset' }, background: { type: 'transparent' }, camera: { view: 'top' } });
    const text = serializeProject(createDoc('B', { ...emptyDocState, render }));
    expect(parseProject(text).state.render).toEqual(render);

    // A file from a newer or broken writer still opens, with what can be understood.
    const odd = JSON.parse(text);
    odd.render = { sun: { elevation: 400, azimuth: 10 }, extra: 1 };
    expect(parseProject(JSON.stringify(odd)).state.render).toEqual(mergeRenderSettings(defaultRenderSettings, { sun: { azimuth: 10 } }));
    odd.render = 5;
    expect(parseProject(JSON.stringify(odd)).state.render).toEqual(defaultRenderSettings);
    odd.render = null;
    expect(parseProject(JSON.stringify(odd)).state.render).toBeUndefined();
  });
});

describe('sun', () => {
  it('points where azimuth and elevation say', () => {
    close(sunDirection(0, 0), [0, 0, 1]);
    close(sunDirection(90, 0), [1, 0, 0]);
    close(sunDirection(180, 0), [0, 0, -1]);
    close(sunDirection(-90, 0), [-1, 0, 0]);
    close(sunDirection(123, 90), [0, 1, 0]);
    close(sunDirection(45, 45), [0.5, Math.SQRT1_2, 0.5]);
    for (const [a, e] of [
      [17, 33],
      [-200, 80],
      [360, 1],
    ]) {
      expect(Math.hypot(...sunDirection(a, e))).toBeCloseTo(1, 12);
    }
  });

  it('knows the size of its disc', () => {
    expect(discSolidAngle(90)).toBeCloseTo(2 * Math.PI, 12);
    // Small discs: pi r^2.
    expect(discSolidAngle(1)).toBeCloseTo(Math.PI * (Math.PI / 180) ** 2, 6);
  });
});

describe('resolveRenderCamera', () => {
  const box: Vec3[] = [];
  for (const x of [-1, 1]) for (const y of [0, 2]) for (const z of [-3, 3]) box.push([x, y, z]);
  const base = { fit: false, fitPoints: box, current: { position: [5, 5, 5] as Vec3, target: [0, 1, 0] as Vec3 }, defaultFov: 40, aspect: 16 / 9 };

  /** Every point is inside the frame of the camera. */
  function inFrame(camera: { position: Vec3; target: Vec3; fov: number }, aspect: number) {
    const f = camera.target.map((v, i) => v - camera.position[i]);
    const len = Math.hypot(...f);
    const forward = f.map((v) => v / len);
    // forward x world up
    let right = [-forward[2], 0, forward[0]];
    const rl = Math.hypot(...right) || 1;
    right = right.map((v) => v / rl);
    const up = [right[1] * forward[2] - right[2] * forward[1], right[2] * forward[0] - right[0] * forward[2], right[0] * forward[1] - right[1] * forward[0]];
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    return box.every((p) => {
      const d = p.map((v, i) => v - camera.position[i]);
      const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
      const x = d[0] * right[0] + d[1] * right[1] + d[2] * right[2];
      const y = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
      return depth > 0 && Math.abs(x) <= depth * tan * aspect + 1e-9 && Math.abs(y) <= depth * tan + 1e-9;
    });
  }

  it('uses the current camera as it is', () => {
    expect(resolveRenderCamera({ ...base, view: 'current' })).toEqual({ position: [5, 5, 5], target: [0, 1, 0], fov: 40 });
  });

  it('frames the points with fit, keeping the viewing direction', () => {
    const camera = resolveRenderCamera({ ...base, view: 'current', fit: true });
    expect(camera.target).toEqual([0, 1, 0]);
    const d = camera.position.map((v, i) => v - camera.target[i]);
    const l = Math.hypot(...d);
    const s = Math.hypot(5, 4, 5);
    close(d.map((v) => v / l), [5 / s, 4 / s, 5 / s]);
    expect(inFrame(camera, 16 / 9)).toBe(true);
    // Not wastefully far away either.
    expect(l).toBeLessThan(20);
  });

  it('puts a preset camera on its side, always framed', () => {
    for (const [view, axis, sign] of [
      ['front', 2, 1],
      ['back', 2, -1],
      ['right', 0, 1],
      ['left', 0, -1],
      ['top', 1, 1],
    ] as const) {
      const camera = resolveRenderCamera({ ...base, view });
      expect(camera.target).toEqual([0, 1, 0]);
      expect(Math.sign(camera.position[axis] - camera.target[axis])).toBe(sign);
      expect(inFrame(camera, 16 / 9)).toBe(true);
    }
    const iso = resolveRenderCamera({ ...base, view: 'iso', aspect: 0.5 });
    expect(iso.position.every((v, i) => v > iso.target[i])).toBe(true);
    expect(inFrame(iso, 0.5)).toBe(true);
  });

  it('takes an explicit camera, with its own or the default field of view', () => {
    const view = { position: [0, 1, 10] as Vec3, target: [0, 1, 0] as Vec3 };
    expect(resolveRenderCamera({ ...base, view })).toEqual({ ...view, fov: 40 });
    expect(resolveRenderCamera({ ...base, view: { ...view, fov: 70 } }).fov).toBe(70);
    const fitted = resolveRenderCamera({ ...base, view: { ...view, fov: 70 }, fit: true });
    expect(fitted.fov).toBe(70);
    expect(fitted.position[0]).toBeCloseTo(0);
    expect(fitted.position[2]).toBeGreaterThan(3);
    expect(inFrame(fitted, 16 / 9)).toBe(true);
  });

  it('falls back to the iso view without a viewport, and copes with an empty scene', () => {
    const camera = resolveRenderCamera({ ...base, view: 'current', current: null });
    expect(camera.position.every((v, i) => v > camera.target[i])).toBe(true);
    expect(inFrame(camera, 16 / 9)).toBe(true);
    const empty = resolveRenderCamera({ ...base, view: 'front', fitPoints: [] });
    expect(empty.target).toEqual([0, 0, 0]);
    close(empty.position, [0, 0, 5]);
    // Fit with nothing to fit leaves the camera alone.
    expect(resolveRenderCamera({ ...base, view: 'current', fit: true, fitPoints: [] }).position).toEqual([5, 5, 5]);
  });
});
