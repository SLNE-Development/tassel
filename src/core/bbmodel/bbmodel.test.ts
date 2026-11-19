import { describe, expect, it } from 'vitest';
import { MISSING_TEXTURE_PNG } from '../minecraft/javaImport';
import { boxUvFaces } from './boxUv';
import { importBbmodel, isBbmodel } from './index';
import { blockbenchToTesselEuler, eulerXyz, matrixFromBlockbench, mul, rotX, rotY, rotZ } from './rotation';

const PNG = `data:image/png;base64,${MISSING_TEXTURE_PNG}`;
const face = (texture: number | null | false, uv = [0, 0, 16, 16], extra: object = {}) => ({ uv, texture, ...extra });
const allFaces = (texture: number | null | false) => Object.fromEntries(['north', 'east', 'south', 'west', 'up', 'down'].map((n) => [n, face(texture)]));
const near = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 3));
const euler = (r: readonly number[]) => mul(rotX(r[0]), mul(rotY(r[1]), rotZ(r[2])));

const javaProject = {
  meta: { format_version: '4.10', model_format: 'java_block', box_uv: false },
  name: 'Test Block',
  parent: 'block/block',
  ambientocclusion: false,
  front_gui_light: true,
  unhandled_root_fields: { custom_key: { a: 1 } },
  resolution: { width: 16, height: 16 },
  elements: [
    {
      name: 'rotated',
      type: 'cube',
      uuid: 'e1',
      from: [0, 0, 0],
      to: [8, 8, 8],
      origin: [4, 4, 4],
      rotation: [0, 45, 0],
      shade: false,
      light_emission: 7,
      faces: {
        north: { uv: [0, 0, 8, 8], texture: 0, cullface: 'north', tint: 1, rotation: 90 },
        south: { uv: [0, 0, 8, 8], texture: 1 },
        up: { uv: [0, 0, 8, 8], texture: null },
      },
    },
    {
      name: 'boxy',
      uuid: 'e2',
      from: [0, 0, 0],
      to: [2, 3, 4],
      origin: [0, 0, 0],
      box_uv: true,
      uv_offset: [0, 0],
      faces: { north: { texture: 0 }, east: { texture: 0 } },
      color: 3,
      locked: true,
    },
    { name: 'fat', uuid: 'e3', from: [4, 4, 4], to: [6, 6, 6], origin: [5, 5, 5], inflate: 0.5, faces: allFaces(0), visibility: false, export: false },
    { name: 'multi', uuid: 'e4', from: [0, 0, 0], to: [1, 1, 1], origin: [0, 0, 0], rotation: [10, 20, 30], faces: allFaces(1) },
    { name: 'hand', type: 'locator', uuid: 'l1' },
    { name: 'm', type: 'mesh', uuid: 'm1', vertices: {}, faces: {} },
  ],
  outliner: [{ name: 'arm', uuid: 'g1', origin: [1, 2, 3], rotation: [0, 0, 22.5], children: ['e1', 'e2', 'l1'] }, 'e3', 'e4'],
  textures: [
    { name: 'stone.png', id: '0', namespace: '', folder: 'block', particle: true, uuid: 't1', source: PNG, width: 16, height: 16 },
    { name: 'side.png', id: 'side', namespace: 'mymod', folder: 'item/x', uuid: 't2' },
  ],
  display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.5, 0.5, 0.5], mirror: [true, false, false] } },
  animations: [{ name: 'walk', uuid: 'a1' }],
};

describe('importBbmodel (java_block)', () => {
  const { state, report } = importBbmodel(JSON.stringify(javaProject), { name: 'my model.bbmodel' });
  const objs = state.order.map((id) => state.objects[id]);

  it('reports the format and what was dropped', () => {
    expect(report).toMatchObject({ format: 'minecraft_java', modelFormat: 'java_block', formatVersion: '4.10', elements: 4 });
    expect(report.dropped).toEqual(
      expect.arrayContaining([
        { kind: 'locator', name: 'hand', reason: 'Locators are not supported' },
        { kind: 'animation', name: 'walk', reason: 'Animations are not imported' },
        expect.objectContaining({ kind: 'mesh', name: 'm' }),
      ]),
    );
    expect(report.warnings.some((w) => w.includes('side.png') && w.includes('placeholder'))).toBe(true);
    expect(report.warnings.some((w) => w.includes('rotation, which is ignored'))).toBe(true);
  });

  it('maps model settings', () => {
    expect(state.format).toBe('minecraft_java');
    expect(state.java).toMatchObject({ fileName: 'my_model', parent: 'block/block', ambientOcclusion: false, guiLight: 'front' });
    expect(state.java?.extra).toEqual({ custom_key: { a: 1 } });
    expect(state.java?.display).toEqual({ gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [-0.5, 0.5, 0.5] } });
  });

  it('maps textures and the particle', () => {
    const tex = Object.values(state.textures);
    expect(tex).toHaveLength(2);
    const stone = tex.find((t) => t.name === 'stone')!;
    expect(stone.java).toMatchObject({ namespace: 'minecraft', folder: 'block', key: '0' });
    expect(stone.data).toBe(MISSING_TEXTURE_PNG);
    expect(state.java?.particle).toBe(stone.id);
    expect(tex.find((t) => t.name === 'side')!.java).toMatchObject({ namespace: 'mymod', folder: 'item/x', key: 'side' });
  });

  it('maps a rotated cube with face details', () => {
    const o = objs[0];
    expect(o.name).toBe('rotated');
    expect(o.transform.rotation).toEqual([0, 45, 0]);
    expect(o.cuboid).toMatchObject({ shade: false, lightEmission: 7, inflate: 0 });
    const north = o.cuboid!.faces.north;
    expect(north).toMatchObject({ enabled: true, cullface: 'north', tintIndex: 1, rotation: 90, uv: [0, 0, 8, 8] });
    expect(o.cuboid!.faces.up.enabled).toBe(false);
    expect(o.cuboid!.faces.east.enabled).toBe(false);
    expect(o.cuboid!.faces.south.texture).not.toBe(north.texture);
  });

  it('computes box UV faces', () => {
    const f = objs[1].cuboid!.faces;
    expect(f.north.uv).toEqual([4, 4, 6, 7]);
    expect(f.east.uv).toEqual([0, 4, 4, 7]);
    expect(f.south.enabled).toBe(false);
    expect(objs[1].cuboid).toMatchObject({ color: 3, locked: true });
  });

  it('applies inflate, visibility and export', () => {
    expect(objs[2].cuboid).toMatchObject({ inflate: 0.5, export: false });
    expect(objs[2].visible).toBe(false);
    expect(objs[2].groupId).toBeNull();
    const maxY = Math.max(...objs[2].mesh.positions.filter((_, i) => i % 3 === 1));
    expect(maxY).toBeCloseTo(1.5 / 16, 5);
  });

  it('puts elements in groups with their pivot', () => {
    const group = Object.values(state.groups)[0];
    expect(group).toMatchObject({ name: 'arm', pivot: [1, 2, 3] });
    expect(objs[0].groupId).toBe(group.id);
    expect(objs[1].groupId).toBe(group.id);
  });

  it('converts multi-axis rotation from ZYX to XYZ order', () => {
    near(euler(objs[3].transform.rotation) as number[], matrixFromBlockbench([10, 20, 30]) as number[]);
  });
});

describe('importBbmodel (5.x groups, old files, errors)', () => {
  it('reads group data from the top-level groups array', () => {
    const { state, report } = importBbmodel(
      JSON.stringify({
        meta: { format_version: '5.0', model_format: 'java_block' },
        elements: [{ uuid: 'a', name: 'c', from: [0, 0, 0], to: [1, 1, 1], faces: {} }],
        groups: [{ uuid: 'g', name: 'Top', origin: [8, 8, 8], rotation: [0, 0, 0] }],
        outliner: [{ uuid: 'g', isOpen: true, children: ['a'] }],
        textures: [],
      }),
    );
    expect(report.elements).toBe(1);
    expect(Object.values(state.groups)[0]).toMatchObject({ name: 'Top', pivot: [8, 8, 8] });
    expect(state.objects[state.order[0]].groupId).toBe(Object.keys(state.groups)[0]);
  });

  it('infers java_block without model_format and free with bone_rig', () => {
    const base = { meta: { format_version: '3.6' }, elements: [{ from: [0, 0, 0], to: [1, 1, 1], faces: {} }], outliner: [] };
    expect(importBbmodel(JSON.stringify(base)).report.modelFormat).toBe('java_block');
    const free = importBbmodel(JSON.stringify({ ...base, meta: { format_version: '3.6', bone_rig: true } }));
    expect(free.report).toMatchObject({ modelFormat: 'free', format: 'free' });
    expect(importBbmodel(JSON.stringify({ meta: { format_version: '3.0' }, cubes: base.elements, outliner: [] })).report.elements).toBe(1);
  });

  it('sniffs and rejects bad input', () => {
    expect(isBbmodel({ meta: { format_version: '4.0' } })).toBe(true);
    expect(isBbmodel({ elements: [], outliner: [] })).toBe(true);
    expect(isBbmodel({ elements: [] })).toBe(false);
    expect(isBbmodel('x')).toBe(false);
    expect(() => importBbmodel('nope')).toThrow(/not valid JSON/);
    expect(() => importBbmodel('[1]')).toThrow(/not a JSON object/);
  });
});

describe('box UV', () => {
  it('mirrors by swapping east and west and flipping horizontally', () => {
    const plain = boxUvFaces([0, 0], [2, 3, 4], false);
    const mirrored = boxUvFaces([0, 0], [2, 3, 4], true);
    expect(mirrored.east).toEqual([plain.west[2], plain.west[1], plain.west[0], plain.west[3]]);
    expect(mirrored.north).toEqual([plain.north[2], plain.north[1], plain.north[0], plain.north[3]]);
  });
});

describe('importBbmodel (free formats)', () => {
  const project = {
    meta: { format_version: '4.9', model_format: 'modded_entity', box_uv: true },
    resolution: { width: 64, height: 32 },
    elements: [
      { name: 'part', uuid: 'c1', from: [8, 0, -1], to: [10, 2, 1], origin: [8, 0, 0], rotation: [0, 0, 0], uv_offset: [0, 0], faces: allFaces(0), mirror_uv: false },
      { name: 'rot', uuid: 'c2', from: [0, 0, 0], to: [2, 2, 2], origin: [1, 1, 1], rotation: [0, 0, 90], faces: allFaces(0), visibility: false },
      {
        name: 'poly',
        type: 'mesh',
        uuid: 'm1',
        origin: [0, 0, 0],
        rotation: [0, 0, 0],
        vertices: { a: [0, 0, 0], b: [16, 0, 0], c: [16, 16, 0], d: [0, 16, 0] },
        // scrambled: a, c, b, d (a bow-tie when taken in order)
        faces: { f1: { vertices: ['a', 'c', 'b', 'd'], uv: { a: [0, 0], b: [16, 0], c: [16, 16], d: [0, 16] }, texture: 0 } },
      },
      { name: 'two', uuid: 'c3', from: [0, 0, 0], to: [1, 1, 1], origin: [0, 0, 0], box_uv: false, faces: { north: face(0), south: face(1), east: face(1), up: face(1) } },
      { name: 'null', type: 'null_object', uuid: 'n1' },
    ],
    outliner: [
      { name: 'body', uuid: 'g1', origin: [0, 0, 0], rotation: [0, 90, 0], children: ['c1', { name: 'inner', uuid: 'g2', origin: [0, 0, 0], rotation: [0, 0, 0], children: ['c2'] }] },
      'm1',
      'c3',
    ],
    textures: [
      { name: 'a.png', source: PNG, width: 16, height: 16, uuid: 'ta' },
      { name: 'b.png', source: PNG, uuid: 'tb', uv_width: 32, uv_height: 32 },
    ],
  };
  const { state, report } = importBbmodel(JSON.stringify(project));
  const byName = (n: string) => Object.values(state.objects).find((o) => o.name === n)!;

  it('creates a free document', () => {
    expect(state.format).toBeUndefined();
    expect(state.java).toBeUndefined();
    expect(report).toMatchObject({ format: 'free', modelFormat: 'modded_entity', elements: 4 });
    expect(report.dropped).toContainEqual(expect.objectContaining({ kind: 'null_object', name: 'null' }));
    expect(report.warnings.some((w) => w.includes('"two"') && w.includes('more than one texture'))).toBe(true);
  });

  it('bakes the group rotation into position and rotation', () => {
    const p = byName('part');
    // Ry(90): (8,0,0) -> (0,0,-8) px
    near(p.transform.position, [0, 0, -0.5]);
    near(p.transform.rotation, [0, 90, 0]);
    expect(p.transform.scale).toEqual([1, 1, 1]);
    const xs = p.mesh.positions.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 / 16, 5);
    expect(Object.values(state.groups).map((g) => g.name)).toEqual(['body', 'inner']);
    expect(state.groups[p.groupId!].name).toBe('body');
  });

  it('composes nested group and element rotations', () => {
    const o = byName('rot');
    expect(o.visible).toBe(false);
    near(euler(o.transform.rotation) as number[], mul(rotY(90), rotZ(90)) as number[]);
    // pivot (1,1,1) turned by Ry(90): (z,y,-x) = (1,1,-1)
    near(o.transform.position, [1 / 16, 1 / 16, -1 / 16]);
  });

  it('gives box-UV cubes a UV per corner and a material', () => {
    const p = byName('part');
    expect(p.mesh.faces).toHaveLength(6);
    expect(p.mesh.uvs).toHaveLength(6);
    expect(p.mesh.uvs![0]).toHaveLength(8);
    const mat = state.materials[p.materialId!];
    expect(mat.baseColor).toBe('#ffffff');
    expect(state.textures[mat.maps.baseColor!].name).toBe('a');
  });

  it('orders scrambled quad vertices into a proper loop facing the first triangle', () => {
    const m = byName('poly');
    expect(m.mesh.faces[0]).toHaveLength(4);
    const pts = m.mesh.faces[0].map((i) => [m.mesh.positions[i * 3], m.mesh.positions[i * 3 + 1]]);
    let area2 = 0;
    for (let i = 0; i < 4; i++) area2 += pts[i][0] * pts[(i + 1) % 4][1] - pts[(i + 1) % 4][0] * pts[i][1];
    expect(Math.abs(area2) / 2).toBeCloseTo(1, 5);
    // the triangle a, c, b is clockwise seen from +Z (normal -Z), so the loop is too
    expect(area2).toBeLessThan(0);
    expect(m.mesh.uvs![0]).toHaveLength(8);
  });

  it('uses the majority texture for a cube with two textures and the texture UV size', () => {
    const t = byName('two');
    const mat = state.materials[t.materialId!];
    expect(state.textures[mat.maps.baseColor!].name).toBe('b');
    expect(t.mesh.faces).toHaveLength(4);
    // uv [0,0,16,16] on a 32x32 UV texture: u covers 0..0.5, v (up) covers 0.5..1
    const us = t.mesh.uvs![0].filter((_, i) => i % 2 === 0);
    const vs = t.mesh.uvs![0].filter((_, i) => i % 2 === 1);
    expect([Math.min(...us), Math.max(...us)]).toEqual([0, 0.5]);
    expect([Math.min(...vs), Math.max(...vs)]).toEqual([0.5, 1]);
  });
});

describe('rotation helpers', () => {
  it('round-trips Euler angles and handles gimbal lock', () => {
    near(eulerXyz(euler([20, 30, 40])), [20, 30, 40]);
    const lock = eulerXyz(euler([20, 90, 40]));
    near(euler(lock) as number[], euler([20, 90, 40]) as number[]);
    near(blockbenchToTesselEuler([0, 0, 45]), [0, 0, 45]);
  });
});
