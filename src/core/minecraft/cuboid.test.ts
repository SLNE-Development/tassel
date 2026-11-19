import { describe, expect, it } from 'vitest';
import { cuboidFaces } from '../types';
import type { PolyMesh, Vec3 } from '../types';
import { createCuboid, cuboidMesh, faceUvCorners, modelBox } from './cuboid';
import { modelToWorld, worldToModel } from './space';
import { addTexture, minecraftApp, type TestApp } from './testing';
import { eulerMatrix, matrixEuler } from './transforms';

/** Outward normal of a mesh face (Newell's method), rounded. */
function normal(mesh: PolyMesh, face: number): Vec3 {
  const f = mesh.faces[face];
  const n: Vec3 = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = f[i] * 3;
    const b = f[(i + 1) % f.length] * 3;
    const p = mesh.positions;
    n[0] += (p[a + 1] - p[b + 1]) * (p[a + 2] + p[b + 2]);
    n[1] += (p[a + 2] - p[b + 2]) * (p[a] + p[b]);
    n[2] += (p[a] - p[b]) * (p[a + 1] + p[b + 1]);
  }
  const len = Math.hypot(...n);
  return n.map((v) => Math.round(v / len) + 0) as Vec3;
}

const box = (t: TestApp, i = 0) => {
  const obj = t.state().objects[t.state().order[i]];
  return { ...modelBox({ ...obj, cuboid: obj.cuboid! }), rotation: obj.transform.rotation, cuboid: obj.cuboid!, obj };
};

describe('model space', () => {
  it('puts the block on the ground, centred on the world origin, 16 px per meter', () => {
    expect(modelToWorld([8, 0, 8])).toEqual([0, 0, 0]);
    expect(modelToWorld([16, 16, 16])).toEqual([0.5, 1, 0.5]);
    expect(worldToModel([-0.5, 0.25, 0.5])).toEqual([0, 4, 16]);
  });
});

describe('cuboid mesh', () => {
  const cuboid = createCuboid([-2, 0, -3], [2, 5, 3], null);

  it('has six outward quads in face order with the box (and inflate) in meters', () => {
    const mesh = cuboidMesh(cuboid);
    expect(mesh.faces).toHaveLength(6);
    expect(mesh.faces.map((_, i) => normal(mesh, i))).toEqual([
      [0, 0, -1],
      [1, 0, 0],
      [0, 0, 1],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
    ]);
    const xs = mesh.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(-2 / 16);
    expect(Math.max(...xs)).toBe(2 / 16);
    const inflated = cuboidMesh({ ...cuboid, inflate: 1 });
    expect(Math.max(...inflated.positions.filter((_, i) => i % 3 === 1))).toBe(6 / 16);
  });

  it('maps the UV rectangle onto the face as Minecraft does (top-left of the texture at the top-left of the face)', () => {
    const faces = { ...cuboid.faces, north: { ...cuboid.faces.north, uv: [0, 0, 4, 5] as const } };
    const mesh = cuboidMesh({ ...cuboid, faces }, [16, 16]);
    // North face seen from the north: its top-left corner is at +X, top.
    const f = mesh.faces[0];
    const corner = (i: number) => [mesh.positions[f[i] * 3], mesh.positions[f[i] * 3 + 1]];
    const uv = (i: number) => [mesh.uvs![0][i * 2], mesh.uvs![0][i * 2 + 1]];
    const topLeft = [0, 1, 2, 3].find((i) => corner(i)[0] > 0 && corner(i)[1] > 0)!;
    expect(uv(topLeft)).toEqual([0, 1]);
    const bottomRight = [0, 1, 2, 3].find((i) => corner(i)[0] < 0 && corner(i)[1] === 0)!;
    expect(uv(bottomRight)).toEqual([4 / 16, 1 - 5 / 16]);
  });

  it('turns the texture clockwise with the face rotation', () => {
    const face = { ...cuboid.faces.up, uv: [0, 0, 2, 4] as const, rotation: 90 as const };
    // The face's top-left corner now shows the texture's bottom-left corner.
    expect(faceUvCorners(face)).toEqual([
      [0, 4],
      [0, 0],
      [2, 0],
      [2, 4],
    ]);
  });

  it('gives a new box auto UV the size of each face', () => {
    expect(cuboidFaces.map((f) => cuboid.faces[f].uv)).toEqual([
      [0, 0, 4, 5],
      [0, 0, 6, 5],
      [0, 0, 4, 5],
      [0, 0, 6, 5],
      [0, 0, 4, 6],
      [0, 0, 4, 6],
    ]);
  });
});

describe('euler helpers', () => {
  it('round-trip Euler XYZ angles through a matrix', () => {
    for (const angles of [
      [0, 0, 0],
      [30, 50, 0],
      [-22.5, 10, 45],
      [90, 0, 0],
    ] as Vec3[]) {
      expect(matrixEuler(eulerMatrix(angles))).toEqual(angles);
    }
  });
});

describe('cuboid commands', () => {
  it('adds a selected element with the box, pivot and rotation in model space', async () => {
    const t = await minecraftApp();
    const tex = await addTexture(t, 'stone');
    const added = await t.run('cuboid.add', { from: [2, 0, 4], to: [10, 6, 12], rotation: [0, 0, 45] });
    expect(added).toMatchObject({ name: 'cube', from: [2, 0, 4], to: [10, 6, 12], origin: [6, 3, 8], rotation: [0, 0, 45] });
    const { obj, cuboid } = box(t);
    expect(t.state().selection).toEqual([obj.id]);
    expect(obj.transform.position).toEqual(modelToWorld([6, 3, 8]));
    expect(cuboid.faces.north.texture).toBe(tex);
    expect(obj.mesh.faces).toHaveLength(6);
  });

  it('keeps the mesh derived when the gizmo moves or scales the element', async () => {
    const t = await minecraftApp();
    const { id } = await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4] });
    await t.run('scene.set_transform', { items: [{ id, position: modelToWorld([10, 2, 8]) }] });
    expect(box(t)).toMatchObject({ from: [8, 0, 6], to: [12, 4, 10], origin: [10, 2, 8] });
    // Scaling bakes into the box: an element always has scale 1.
    await t.run('scene.set_transform', { items: [{ id, scale: [2, 1, 0.5] }] });
    const after = box(t);
    expect(after.obj.transform.scale).toEqual([1, 1, 1]);
    expect(after).toMatchObject({ from: [6, 0, 7], to: [14, 4, 9] });
    expect(Math.max(...after.obj.mesh.positions.filter((_, i) => i % 3 === 0))).toBe(4 / 16);
  });

  it('updates the box, pivot and flags, and refuses geometry changes of locked elements', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4] });
    await t.run('cuboid.update', { from: [1, 1, 1], to: [5, 9, 3], lightEmission: 7, shadeDirectionOverride: 'up', shade: false });
    expect(box(t)).toMatchObject({ from: [1, 1, 1], to: [5, 9, 3], origin: [2, 2, 2] });
    expect(box(t).cuboid).toMatchObject({ lightEmission: 7, shadeDirectionOverride: 'up', shade: false });
    await t.run('cuboid.set_pivot', { origin: [8, 8, 8] });
    expect(box(t)).toMatchObject({ from: [1, 1, 1], to: [5, 9, 3], origin: [8, 8, 8] });
    await t.run('cuboid.set_pivot', { center: true });
    expect(box(t).origin).toEqual([3, 5, 2]);
    await t.run('cuboid.update', { locked: true });
    await expect(t.run('cuboid.move', { offset: [1, 0, 0] })).rejects.toThrow(/locked/);
    await t.run('cuboid.update', { locked: false, from: [0, 0, 0] });
    expect(box(t).from).toEqual([0, 0, 0]);
  });

  it('moves, resizes per side and from the centre, and centres', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4] });
    await t.run('cuboid.move', { offset: [1, 2, 3] });
    expect(box(t)).toMatchObject({ from: [1, 2, 3], to: [5, 6, 7], origin: [3, 4, 5] });
    await t.run('cuboid.resize', { axis: 'x', amount: 2 });
    expect(box(t)).toMatchObject({ from: [1, 2, 3], to: [7, 6, 7] });
    await t.run('cuboid.resize', { axis: 'y', amount: 1, side: 'min' });
    expect(box(t)).toMatchObject({ from: [1, 1, 3], to: [7, 6, 7] });
    await t.run('cuboid.resize', { axis: 'z', amount: 2, side: 'both' });
    expect(box(t)).toMatchObject({ from: [1, 1, 2], to: [7, 6, 8] });
    await t.run('cuboid.resize', { axis: 'z', amount: -100 });
    expect(box(t)).toMatchObject({ from: [1, 1, 2], to: [7, 6, 2] });
    await t.run('cuboid.center');
    expect(box(t)).toMatchObject({ from: [5, 1, 8], to: [11, 6, 8] });
  });

  it('flips with mirrored faces, UVs, cullfaces and rotation', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 2, 6], origin: [0, 0, 0], rotation: [10, 20, 30] });
    await t.run('cuboid.set_face', { faces: ['east'], uv: [1, 2, 7, 4], cullface: 'east' });
    await t.run('cuboid.flip', { axis: 'x', around: 'block' });
    const after = box(t);
    expect(after).toMatchObject({ from: [12, 0, 0], to: [16, 2, 6], origin: [16, 0, 0], rotation: [10, -20, -30] });
    // The east face is now the west face, read mirrored.
    expect(after.cuboid.faces.west).toMatchObject({ uv: [7, 2, 1, 4], rotation: 0, cullface: 'west' });
    // Flipping twice gives the original back.
    await t.run('cuboid.flip', { axis: 'x', around: 'block' });
    expect(box(t).cuboid.faces.east).toMatchObject({ uv: [1, 2, 7, 4], cullface: 'east' });
    expect(box(t).rotation).toEqual([10, 20, 30]);
  });

  it('turns by 90 degrees with the faces going round', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 2, 6] });
    await t.run('cuboid.set_face', { faces: ['north'], uv: [3, 3, 7, 5] });
    await t.run('cuboid.set_face', { faces: ['up'], uv: [0, 0, 4, 6] });
    await t.run('cuboid.rotate90', { axis: 'y', direction: 1, around: 'block' });
    const after = box(t);
    // Counter-clockwise seen from above: -Z (north) goes to -X (west).
    expect(after).toMatchObject({ from: [0, 0, 12], to: [6, 2, 16] });
    expect(after.cuboid.faces.west.uv).toEqual([3, 3, 7, 5]);
    expect(after.cuboid.faces.up.rotation).toBe(270);
    // Four turns are the identity.
    for (let i = 0; i < 3; i++) await t.run('cuboid.rotate90', { axis: 'y', direction: 1, around: 'block' });
    expect(box(t)).toMatchObject({ from: [0, 0, 0], to: [4, 2, 6] });
    expect(box(t).cuboid.faces.north.uv).toEqual([3, 3, 7, 5]);
    expect(box(t).cuboid.faces.up).toMatchObject({ uv: [0, 0, 4, 6], rotation: 0 });
  });

  it('edits face UVs', async () => {
    const t = await minecraftApp({ textureSize: [32, 32] });
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 2, 6] });
    await t.run('cuboid.uv', { op: 'maximize', faces: ['north'] });
    expect(box(t).cuboid.faces.north.uv).toEqual([0, 0, 32, 32]);
    await t.run('cuboid.uv', { op: 'auto', faces: ['north'] });
    expect(box(t).cuboid.faces.north.uv).toEqual([0, 0, 4, 2]);
    await t.run('cuboid.uv', { op: 'mirror_x', faces: ['north'] });
    expect(box(t).cuboid.faces.north.uv).toEqual([4, 0, 0, 2]);
    await t.run('cuboid.uv', { op: 'mirror_y', faces: ['north'] });
    expect(box(t).cuboid.faces.north.uv).toEqual([4, 2, 0, 0]);
    await t.run('cuboid.uv', { op: 'rotate', faces: ['north'] });
    expect(box(t).cuboid.faces.north.rotation).toBe(90);
    await t.run('cuboid.uv', { op: 'apply_to_all', source: 'north' });
    expect(cuboidFaces.map((f) => box(t).cuboid.faces[f].uv)).toEqual(cuboidFaces.map(() => [4, 2, 0, 0]));
    await t.run('cuboid.set_face', { faces: ['up'], tintIndex: 0, enabled: false });
    expect(box(t).cuboid.faces.up).toMatchObject({ tintIndex: 0, enabled: false });
  });

  it('sets cullfaces on the faces that touch the block boundary', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 4], to: [16, 8, 16] });
    await t.run('cuboid.auto_cullface');
    expect(cuboidFaces.map((f) => box(t).cuboid.faces[f].cullface)).toEqual([null, 'east', 'south', 'west', null, 'down']);
  });

  it('removes faces that show nothing', async () => {
    const t = await minecraftApp({}, { imaging: { regionTransparent: async (_t, rect) => rect.x >= 8 } as never });
    const tex = await addTexture(t, 'stone');
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4], texture: tex });
    await t.run('cuboid.set_face', { faces: ['east'], texture: null });
    await t.run('cuboid.set_face', { faces: ['south'], uv: [3, 3, 3, 7] });
    await t.run('cuboid.set_face', { faces: ['west'], uv: [8, 0, 12, 4] });
    const result = await t.run('cuboid.remove_blank_faces');
    expect(result.removed).toBe(3);
    expect(cuboidFaces.map((f) => box(t).cuboid.faces[f].enabled)).toEqual([true, false, false, false, true, true]);
  });

  it('keeps face textures valid when a texture is removed', async () => {
    const t = await minecraftApp();
    const tex = await addTexture(t, 'stone');
    await t.run('cuboid.add', { texture: tex });
    await t.run('minecraft.set_settings', { particle: tex });
    await t.run('texture.remove', { id: tex });
    expect(box(t).cuboid.faces.north.texture).toBeNull();
    expect(t.state().java!.particle).toBeNull();
  });

  it('duplicates elements and undoes edits as one step each', async () => {
    const t = await minecraftApp();
    await t.run('cuboid.add', { from: [0, 0, 0], to: [4, 4, 4] });
    await t.run('scene.duplicate_objects');
    expect(t.state().order).toHaveLength(2);
    expect(box(t, 1).cuboid).toEqual(box(t, 0).cuboid);
    await t.run('cuboid.move', { offset: [4, 0, 0] });
    await t.run('history.undo');
    expect(box(t, 1).from).toEqual([0, 0, 0]);
  });
});
