import { deflateSync } from 'node:zlib';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import { commandsById } from '../core/commands';
import { MAX_IMPORT_BASE64, addImported } from '../core/commands/files';
import { runCommand, type CommandContext } from '../core/commands/registry';
import { boundingBox } from '../core/mesh/polymesh';
import { evaluateObject } from '../core/modifiers/evaluate';
import { activeDoc, createAppState, emptyDocState } from '../core/state';
import type { AppState, DocState, ExportService, ImportedScene, ImportService, PolyMesh } from '../core/types';
import { dataUriBytes, fromBase64, tidyFloat, toBase64 } from './bytes';
import { imageSize, sniffImage } from './imageInfo';
import { channelPixels, packPixels, type ImageOps } from './imageOps';
import { createExporter, createImporter } from './index';
import { fileStem, sanitizeFileName, uniqueFileName } from './names';
import { parseObj } from './obj';
import { bakeMesh, indexedTriangles } from './scene';
import { looksSmooth, soupToPolyMesh } from './soup';
import { decomposeMatrix } from './threeImport';

// --- A tiny PNG encoder, so the tests have real image files -------------------------------------
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function png(width: number, height: number, rgb: [number, number, number] = [200, 50, 50]): string {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(rgb, y * (1 + width * 3) + 1 + x * 3);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return toBase64(out);
}

/** Stands in for the canvas work: "packs" into a fixed 2x2 image and "splits" into fixed images. */
const packedPng = png(2, 2, [255, 128, 64]);
const roughnessPng = png(2, 2, [128, 128, 128]);
const fakeOps: ImageOps & { packCalls: (string | null)[][] } = {
  packCalls: [],
  async packMetallicRoughness(roughness, metallic) {
    this.packCalls.push([roughness?.id ?? null, metallic?.id ?? null]);
    return { mimeType: 'image/png', data: packedPng, width: 2, height: 2 };
  },
  async splitChannels(_image, channels) {
    // Occlusion (R) is white, metallic (B) is white: only roughness comes back.
    return channels.map((c) => (c === 'g' ? { mimeType: 'image/png' as const, data: roughnessPng, width: 2, height: 2 } : null));
  },
};

// --- A document built with the real commands -----------------------------------------------------
let app: AppState;
const exporter: ExportService = createExporter(fakeOps);
const importer: ImportService = createImporter(fakeOps);
const ctx: CommandContext = {
  get: () => app,
  set: (update) => {
    app = update(app);
  },
  services: { viewport: null, exporter, importer },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(id: string, params?: unknown): Promise<any> {
  const def = commandsById.get(id);
  if (!def) throw new Error(`Unknown command ${id}`);
  return runCommand(def, ctx, params);
}
const state = (): DocState => activeDoc(app).state;
/** Runs import.file and returns the first new object. */
async function imported(params: unknown) {
  const result = await run('import.file', params);
  return state().objects[result.objects[0].id];
}

const arrow = png(4, 2);
interface Built {
  cube: string;
  sphere: string;
  plain: string;
  material: string;
  texture: string;
  group: string;
}
/** A textured, unwrapped, rotated cube in a nested group, a smooth sphere, and a cube without material or UVs. */
async function buildScene(): Promise<Built> {
  const cube = (await run('scene.add_primitive', { type: 'cube', name: 'Kiste', position: [1, 2, 3], rotation: [0, 90, 0], scale: [1, 2, 1] })).id;
  await run('uv.unwrap', { objectId: cube, method: 'box' });
  const texture = (await run('texture.add', { name: 'arrow.png', mimeType: 'image/png', data: arrow, width: 4, height: 2 })).id;
  const material = (
    await run('material.create', { name: 'Rot lackiert', baseColor: '#cc3311', metallic: 0.25, roughness: 0.4, emissive: '#102030', emissiveStrength: 2.5, normalScale: 0.5, assignTo: [cube] })
  ).id;
  await run('material.update', { id: material, maps: { baseColor: texture, normal: texture } });
  const sphere = (await run('scene.add_primitive', { type: 'uv_sphere', name: 'Kugel', position: [-2, 0, 0] })).id;
  await run('scene.set_smooth', { ids: [sphere], smooth: true });
  await run('modifier.add', { objectId: sphere, type: 'subdivision', levels: 1 });
  const plain = (await run('scene.add_primitive', { type: 'cube', name: 'Ohne', position: [0, 0, -4] })).id;
  const outer = (await run('group.create', { ids: [], name: 'Aussen' })).id;
  const group = (await run('group.create', { ids: [cube], name: 'Innen', parentId: outer })).id;
  return { cube, sphere, plain, material, texture, group };
}

function glbJson(base64: string) {
  const bytes = fromBase64(base64);
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(8, true)).toBe(bytes.length);
  const length = view.getUint32(12, true);
  return { json: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))), bytes };
}

const close = (a: readonly number[], b: readonly number[], digits = 5) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], digits));
const box = (mesh: PolyMesh) => boundingBox(mesh)!;
/** UV of every corner by rounded position, to compare meshes whose vertex order differs. */
function uvByCorner(mesh: PolyMesh): Map<string, string[]> {
  const out = new Map<string, string[]>();
  mesh.faces.forEach((face, f) =>
    face.forEach((v, c) => {
      const key = [0, 1, 2].map((k) => (Math.round(mesh.positions[v * 3 + k] * 1e4) / 1e4 || 0).toFixed(4)).join(',');
      const list = out.get(key) ?? [];
      list.push(`${mesh.uvs![f][c * 2].toFixed(4)},${mesh.uvs![f][c * 2 + 1].toFixed(4)}`);
      out.set(key, list);
    }),
  );
  for (const list of out.values()) list.sort();
  return out;
}

beforeEach(() => {
  app = createAppState();
  fakeOps.packCalls = [];
});

describe('helpers', () => {
  it('sanitises file names that come from the document', () => {
    expect(sanitizeFileName('..\\..\\Windows\\evil.png')).toBe('Windows_evil.png');
    expect(sanitizeFileName('a/b:c*d?"<>|')).toBe('a_b_c_d');
    expect(sanitizeFileName('my  texture\n1')).toBe('my_texture_1');
    expect(sanitizeFileName('...')).toBe('file');
    expect(sanitizeFileName('CON', 'model')).toBe('model');
    expect(sanitizeFileName('')).toBe('file');
    expect(sanitizeFileName('Größe')).toBe('Größe');
    const taken = new Set<string>();
    expect(uniqueFileName(taken, 'a', '.png')).toBe('a.png');
    expect(uniqueFileName(taken, 'A', '.png')).toBe('A_2.png');
    expect(fileStem('C:\\x\\chair.v2.glb')).toBe('chair.v2');
  });

  it('reads image types and sizes from file headers', () => {
    const bytes = fromBase64(png(4, 2));
    expect(sniffImage(bytes)).toBe('image/png');
    expect(imageSize(bytes)).toEqual({ width: 4, height: 2 });
    // JPEG: SOI, APP0 (length 4), SOF0 with height 3 and width 5.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 5, 3, 0, 0, 0]);
    expect(sniffImage(jpeg)).toBe('image/jpeg');
    expect(imageSize(jpeg)).toEqual({ width: 5, height: 3 });
    expect(sniffImage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('decodes data URIs and tidies float32 noise', () => {
    expect([...dataUriBytes('data:application/octet-stream;base64,AQID')!.bytes]).toEqual([1, 2, 3]);
    expect(dataUriBytes('textures/wood.png')).toBeNull();
    expect(tidyFloat(Math.fround(0.1))).toBe(0.1);
    expect(tidyFloat(Math.fround(-2.35))).toBe(-2.35);
  });

  it('packs and splits scalar maps by channel', () => {
    const grey = (v: number) => new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]);
    expect([...packPixels(grey(10), null, 2)]).toEqual([255, 10, 255, 255, 255, 10, 255, 255]);
    expect([...packPixels(grey(10), grey(200), 2)]).toEqual([255, 10, 200, 255, 255, 10, 200, 255]);
    const packed = new Uint8ClampedArray([255, 10, 200, 255, 255, 20, 200, 255]);
    expect(channelPixels(packed, 'r')).toBeNull();
    expect([...channelPixels(packed, 'g')!]).toEqual([10, 10, 10, 255, 20, 20, 20, 255]);
  });
});

describe('soupToPolyMesh', () => {
  // Two triangles of a unit quad as loaders deliver them: six separate corners.
  const quad = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  const quadUvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];

  it('welds vertices at the same position and keeps UVs per corner', () => {
    const { mesh, dropped } = soupToPolyMesh({ positions: quad, indices: null, uvs: quadUvs });
    expect(dropped).toBe(0);
    expect(mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(mesh.faces).toEqual([
      [0, 1, 2],
      [0, 2, 3],
    ]);
    expect(mesh.uvs).toEqual([
      [0, 0, 1, 0, 1, 1],
      [0, 0, 1, 1, 0, 1],
    ]);
  });

  it('welds float32 values that differ only by noise, and flips v on request', () => {
    const positions = new Float32Array([0.1, 0, 0, 1, 0, 0, 1, 1, 0]);
    const { mesh } = soupToPolyMesh({ positions: [...positions, 0.1, 0, 0, 1, 1, 0, 0, 1, 0], indices: null, uvs: [0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], flipV: true });
    expect(mesh.positions.slice(0, 3)).toEqual([0.1, 0, 0]);
    expect(mesh.positions).toHaveLength(12);
    expect(mesh.uvs![0].slice(0, 2)).toEqual([0, 0.75]);
    expect(mesh.uvs![1][5]).toBe(0);
  });

  it('drops degenerate and non-finite triangles without leaving unused vertices', () => {
    const positions = [0, 0, 0, 1, 0, 0, 1, 0, 0, /* fine: */ 0, 0, 0, 1, 0, 0, 0, 1, 0, /* NaN: */ 5, 5, 5, NaN, 0, 0, 6, 6, 6];
    const { mesh, dropped } = soupToPolyMesh({ positions, indices: null });
    expect(dropped).toBe(2);
    expect(mesh.faces).toEqual([[0, 1, 2]]);
    expect(mesh.positions).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(mesh.uvs).toBeUndefined();
  });

  it('uses indices and ranges, and reverses the winding under a mirroring matrix', () => {
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
    const indices = [0, 1, 2, 0, 2, 3];
    expect(soupToPolyMesh({ positions, indices, start: 3, count: 3 }).mesh.faces).toEqual([[0, 1, 2]]);
    const mirror = new Matrix4().makeScale(-1, 1, 1).setPosition(10, 0, 0).elements;
    const { mesh } = soupToPolyMesh({ positions, indices, uvs: [0, 0, 1, 0, 1, 1, 0, 1], matrix: mirror });
    expect(mesh.positions.slice(0, 9)).toEqual([10, 0, 0, 9, 1, 0, 9, 0, 0]);
    expect(mesh.faces[0]).toEqual([0, 1, 2]);
    // The corner order is 0, 2, 1 of the source triangle, UVs follow.
    expect(mesh.uvs![0]).toEqual([0, 0, 1, 1, 1, 0]);
  });

  it('tells smooth from flat normals', () => {
    const flat = [0, 0, 1, 0, 0, 1, 0, 0, 1];
    const round = [0, 0, 1, 0.6, 0, 0.8, 0, 0.6, 0.8];
    expect(looksSmooth(flat, null, 3)).toBe(false);
    expect(looksSmooth(round, null, 3)).toBe(true);
    expect(looksSmooth(null, null, 3)).toBe(false);
  });
});

describe('transforms', () => {
  it('decomposes clean matrices and refuses shear and mirroring', () => {
    const t = { position: [1, 2, 3], rotation: [10, 20, 30], scale: [1, 2, 0.5] } as const;
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const m = new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion().setFromEuler(new Euler(rad(10), rad(20), rad(30), 'XYZ')), new Vector3(1, 2, 0.5));
    const back = decomposeMatrix(m)!;
    close(back.position, t.position);
    close(back.rotation, t.rotation);
    close(back.scale, t.scale);
    expect(decomposeMatrix(new Matrix4().makeScale(-1, 1, 1))).toBeNull();
    expect(decomposeMatrix(new Matrix4().makeShear(0, 0.5, 0, 0, 0, 0))).toBeNull();
    expect(decomposeMatrix(new Matrix4().makeScale(0, 1, 1))).toBeNull();
  });

  it('bakes matrices into meshes, reversing faces when mirrored', () => {
    const mesh: PolyMesh = { positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], faces: [[0, 1, 2, 3]], uvs: [[0, 0, 1, 0, 1, 1, 0, 1]] };
    const moved = bakeMesh(mesh, new Matrix4().makeTranslation(0, 0, 2));
    expect(moved.positions.slice(0, 3)).toEqual([0, 0, 2]);
    expect(moved.faces).toBe(mesh.faces);
    const mirrored = bakeMesh(mesh, new Matrix4().makeScale(-1, 1, 1));
    expect(mirrored.faces).toEqual([[0, 3, 2, 1]]);
    expect(mirrored.uvs).toEqual([[0, 0, 0, 1, 1, 1, 1, 0]]);
  });

  it('indexes triangles: shared corners of a smooth mesh merge, flat ones stay apart', async () => {
    const { plain } = await buildScene();
    const mesh = state().objects[plain].mesh;
    expect(indexedTriangles(mesh, true).positions).toHaveLength(8 * 3);
    expect(indexedTriangles(mesh, false).positions).toHaveLength(24 * 3);
    expect(indexedTriangles(mesh, false).indices).toHaveLength(36);
  });
});

describe('export', () => {
  it('writes a GLB with UVs, materials, the original image bytes and the group hierarchy', async () => {
    const built = await buildScene();
    const result = await run('export.file', { format: 'glb' });
    expect(result.format).toBe('glb');
    const { json, bytes } = glbJson(result.base64);
    expect(json.asset.version).toBe('2.0');
    // Groups become parent nodes without a transform.
    const names = json.nodes.map((n: { name: string }) => n.name);
    expect(names).toEqual(['Aussen', 'Innen', 'Kiste', 'Kugel', 'Ohne']);
    expect(json.scenes[0].nodes).toEqual([0, 3, 4]);
    expect(json.nodes[0]).toEqual({ name: 'Aussen', children: [1] });
    expect(json.nodes[1]).toEqual({ name: 'Innen', children: [2] });
    const kiste = json.nodes[2];
    expect(kiste.translation).toEqual([1, 2, 3]);
    expect(kiste.scale).toEqual([1, 2, 1]);
    close(kiste.rotation, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    expect(json.nodes[4].rotation).toBeUndefined();

    expect(json.meshes).toHaveLength(3);
    const cubePrimitive = json.meshes[kiste.mesh].primitives[0];
    expect(Object.keys(cubePrimitive.attributes).sort()).toEqual(['NORMAL', 'POSITION', 'TEXCOORD_0']);
    expect(json.accessors[cubePrimitive.attributes.POSITION].count).toBe(24);
    expect(json.accessors[cubePrimitive.attributes.POSITION].min).toEqual([-1, -1, -1]);
    expect(json.accessors[cubePrimitive.indices].count).toBe(36);
    expect(json.meshes[json.nodes[4].mesh].primitives[0].attributes.TEXCOORD_0).toBeUndefined();
    // The sphere is exported after its subdivision modifier.
    const sphere = state().objects[built.sphere];
    expect(json.accessors[json.meshes[json.nodes[3].mesh].primitives[0].indices].count).toBeGreaterThan(sphere.mesh.faces.length * 6);

    expect(json.materials.map((m: { name: string }) => m.name)).toEqual(['Rot lackiert', 'Default']);
    const material = json.materials[0];
    close(material.pbrMetallicRoughness.baseColorFactor, [0.603827, 0.033105, 0.005605, 1]);
    expect(material.pbrMetallicRoughness.metallicFactor).toBe(0.25);
    expect(material.pbrMetallicRoughness.roughnessFactor).toBe(0.4);
    expect(material.pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
    expect(material.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(2.5);
    expect(json.extensionsUsed).toEqual(['KHR_materials_emissive_strength']);
    expect(json.images).toEqual([{ name: 'arrow.png', mimeType: 'image/png', bufferView: expect.any(Number) }]);
    // The image is stored byte for byte.
    const view = json.bufferViews[json.images[0].bufferView];
    const binStart = 20 + new DataView(bytes.buffer).getUint32(12, true) + 8;
    expect(toBase64(bytes.subarray(binStart + view.byteOffset, binStart + view.byteOffset + view.byteLength))).toBe(arrow);
    expect(fakeOps.packCalls).toEqual([]);

    // v is flipped: our v = 0 (bottom of the image) is glTF's v = 1.
    const uvAccessor = json.accessors[cubePrimitive.attributes.TEXCOORD_0];
    const uvView = json.bufferViews[uvAccessor.bufferView];
    const uvs = new Float32Array(bytes.buffer.slice(binStart + uvView.byteOffset, binStart + uvView.byteOffset + uvView.byteLength));
    const ours = state().objects[built.cube].mesh.uvs!.flat();
    const vs = (list: ArrayLike<number>) => [...Array.from(list).filter((_, i) => i % 2 === 1)].sort((a, b) => a - b);
    close([Math.min(...vs(uvs))], [1 - Math.max(...vs(ours))]);
    close([Math.max(...vs(uvs))], [1 - Math.min(...vs(ours))]);
  });

  it('exports only the selection, and only visible objects', async () => {
    const built = await buildScene();
    await run('scene.select', { ids: [built.plain] });
    const { json } = glbJson((await run('export.file', { format: 'glb', selectionOnly: true })).base64);
    expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(['Ohne']);
    expect(json.images).toBeUndefined();
    await run('scene.set_visible', { ids: [built.plain], visible: false });
    await expect(run('export.file', { format: 'stl', selectionOnly: true })).rejects.toThrow('all selected objects are hidden');
    await run('scene.select', { ids: [] });
    await expect(run('export.file', { format: 'glb', selectionOnly: true })).rejects.toThrow('Nothing is selected');
    const all = glbJson((await run('export.file', { format: 'glb' })).base64).json;
    expect(all.nodes.map((n: { name: string }) => n.name)).not.toContain('Ohne');
  });

  it('keeps export.gltf as an alias and embeds everything in .gltf text', async () => {
    await buildScene();
    const binary = await run('export.gltf', {});
    expect(binary.format).toBe('glb');
    expect(binary.base64).toBe((await run('export.file', { format: 'glb' })).base64);
    const text = await run('export.gltf', { binary: false });
    expect(text.format).toBe('gltf');
    const json = JSON.parse(text.text);
    expect(json.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    expect(json.images[0].uri).toBe(`data:image/png;base64,${arrow}`);
    expect(json.images[0].bufferView).toBeUndefined();
  });

  it('packs roughness and metallic maps into one image and marks WebP', async () => {
    const built = await buildScene();
    const rough = (await run('texture.add', { name: 'rough', mimeType: 'image/png', data: png(2, 2, [90, 90, 90]), width: 2, height: 2 })).id;
    await run('material.update', { id: built.material, maps: { roughness: rough, occlusion: rough } });
    const { json } = glbJson((await run('export.file', { format: 'glb' })).base64);
    expect(fakeOps.packCalls).toEqual([[rough, null]]);
    const material = json.materials[0];
    const packed = json.textures[material.pbrMetallicRoughness.metallicRoughnessTexture.index];
    expect(json.images[packed.source].name).toBe('Rot lackiert_metallicRoughness');
    // Occlusion keeps the original image.
    expect(json.images[json.textures[material.occlusionTexture.index].source].name).toBe('rough');
    expect(json.images).toHaveLength(3);
  });

  it('writes OBJ with polygons, vt/vn, usemtl and an MTL with image files', async () => {
    const built = await buildScene();
    const result = await run('export.file', { format: 'obj', name: 'my scene' });
    expect(result.mtlName).toBe('my_scene.mtl');
    const lines: string[] = result.text.split('\n');
    expect(lines[1]).toBe('mtllib my_scene.mtl');
    expect(lines.filter((l) => l.startsWith('o '))).toEqual(['o Kiste', 'o Kugel', 'o Ohne']);
    const section = (name: string) => {
      const start = lines.indexOf(`o ${name}`);
      const end = lines.findIndex((l, i) => i > start && l.startsWith('o '));
      return lines.slice(start, end === -1 ? undefined : end);
    };
    const kiste = section('Kiste');
    expect(kiste.filter((l) => l.startsWith('v '))).toHaveLength(8);
    // Quads stay quads, each corner has position/uv/normal.
    const faces = kiste.filter((l) => l.startsWith('f '));
    expect(faces).toHaveLength(6);
    for (const f of faces) expect(f).toMatch(/^f( \d+\/\d+\/\d+){4}$/);
    expect(kiste.filter((l) => l.startsWith('vn '))).toHaveLength(6);
    expect(kiste).toContain('usemtl Rot_lackiert');
    expect(kiste).toContain('s off');
    // World space: the cube is scaled 1,2,1 and moved to 1,2,3.
    const ys = kiste.filter((l) => l.startsWith('v ')).map((l) => Number(l.split(' ')[2]));
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([0, 4]);
    expect(section('Kugel')).toContain('s 1');
    expect(section('Ohne').some((l) => l.startsWith('vt '))).toBe(false);
    expect(section('Ohne').filter((l) => l.startsWith('f '))[0]).toMatch(/^f( \d+\/\/\d+){4}$/);
    expect(section('Ohne')).toContain('usemtl Default');

    expect(result.mtl).toContain('newmtl Rot_lackiert\nKd 0.8 0.2 0.066667\n');
    expect(result.mtl).toContain('Pr 0.4\nPm 0.25\nmap_Kd my_scene_arrow.png');
    expect(result.mtl).toContain('newmtl Default');
    expect(result.files).toEqual([{ name: 'my_scene_arrow.png', base64: arrow }]);

    // And back: polygons, UVs and the material assignment survive.
    const scene = parseObj(result.text, 'x');
    expect(scene.objects.map((o) => [o.name, o.mesh.faces.length, o.smooth])).toEqual([
      ['Kiste', 6, false],
      ['Kugel', evaluateObject(state(), built.sphere).mesh.faces.length, true],
      ['Ohne', 6, false],
    ]);
    expect(scene.objects[0].mesh.positions).toHaveLength(24);
    expect(scene.objects[0].mesh.faces.every((f) => f.length === 4)).toBe(true);
    expect(scene.materials.map((m) => m.name)).toEqual(['Rot_lackiert', 'Default']);
    expect(scene.objects[0].material).toBe(0);
    expect(scene.warnings[0]).toContain('my_scene.mtl');
    expect(box(scene.objects[0].mesh)).toEqual({ min: [0, 0, 2], max: [2, 4, 4] });
  });

  it('writes binary STL and PLY in world space', async () => {
    const built = await buildScene();
    await run('scene.select', { ids: [built.cube] });
    const stl = fromBase64((await run('export.file', { format: 'stl', selectionOnly: true })).base64);
    expect(stl.length).toBe(84 + 12 * 50);
    expect(new DataView(stl.buffer).getUint32(80, true)).toBe(12);

    const ply = fromBase64((await run('export.file', { format: 'ply', selectionOnly: true })).base64);
    const header = new TextDecoder().decode(ply.subarray(0, 400)).split('end_header\n')[0];
    expect(header).toContain('format binary_little_endian 1.0');
    expect(header).toContain('element vertex 24');
    expect(header).toContain('property float nx');
    expect(header).toContain('property float s\nproperty float t');
    expect(header).toContain('element face 12');
    expect(ply.length).toBe(header.length + 'end_header\n'.length + 24 * 32 + 12 * 13);
  });
});

describe('import', () => {
  it('round-trips a scene through GLB', async () => {
    const built = await buildScene();
    const before = state();
    const glb = (await run('export.file', { format: 'glb' })).base64;
    await run('document.new', {});
    const result = await run('import.file', { format: 'glb', name: 'scene.glb', base64: glb });
    const s = state();
    expect(result.objects.map((o: { name: string }) => o.name)).toEqual(['Kiste', 'Kugel', 'Ohne']);
    expect(result.groups.map((g: { name: string }) => g.name)).toEqual(['Aussen', 'Innen']);
    expect(result.materials.map((m: { name: string }) => m.name)).toEqual(['Rot lackiert', 'Default']);
    expect(result.textures.map((t: { name: string }) => t.name)).toEqual(['arrow.png']);
    expect(result.warnings).toEqual([]);
    expect(s.selection).toEqual(result.objects.map((o: { id: string }) => o.id));
    expect(activeDoc(app).past).toHaveLength(1);

    const [cube, sphere, plain] = result.objects.map((o: { id: string }) => s.objects[o.id]);
    const source = before.objects[built.cube];
    // Triangles of the same 8 vertices, same transform, same UVs per corner.
    expect(cube.mesh.positions).toHaveLength(24);
    expect(cube.mesh.faces).toHaveLength(12);
    expect(box(cube.mesh)).toEqual(box(source.mesh));
    close(cube.transform.position, source.transform.position);
    close(cube.transform.rotation, source.transform.rotation);
    close(cube.transform.scale, source.transform.scale);
    expect(cube.smooth).toBe(false);
    const sourceUvs = uvByCorner(source.mesh);
    for (const [corner, uvs] of uvByCorner(cube.mesh)) expect(new Set(sourceUvs.get(corner))).toEqual(new Set(uvs));
    expect(s.groups[cube.groupId!].name).toBe('Innen');
    expect(s.groups[s.groups[cube.groupId!].parentId!].name).toBe('Aussen');
    expect(sphere.groupId).toBeNull();
    expect(sphere.smooth).toBe(true);
    expect(plain.mesh.uvs).toBeUndefined();

    const material = s.materials[cube.materialId!];
    const { id: _id, maps, ...values } = material;
    const { id: _sourceId, maps: _sourceMaps, ...sourceValues } = before.materials[built.material];
    expect(values).toEqual(sourceValues);
    const texture = s.textures[maps.baseColor!];
    expect({ ...texture, id: '' }).toEqual({ ...before.textures[built.texture], id: '' });
    expect(s.materials[plain.materialId!].baseColor).toBe('#b9b5ae');

    // One undo step removes everything again.
    await run('history.undo', {});
    expect(state().order).toEqual([]);
    expect(state().materials).toEqual({});
    expect(state().groups).toEqual({});
  });

  it('reads self-contained .gltf text, splits the packed map, and names things uniquely on a second import', async () => {
    const built = await buildScene();
    const rough = (await run('texture.add', { name: 'rough', mimeType: 'image/png', data: png(2, 2, [90, 90, 90]), width: 2, height: 2 })).id;
    await run('material.update', { id: built.material, maps: { roughness: rough } });
    const text = (await run('export.file', { format: 'gltf' })).text;
    const result = await run('import.file', { format: 'gltf', name: 'scene.gltf', text });
    expect(result.objects.map((o: { name: string }) => o.name)).toEqual(['Kiste.001', 'Kugel.001', 'Ohne.001']);
    expect(result.groups.map((g: { name: string }) => g.name)).toEqual(['Aussen.001', 'Innen.001']);
    expect(result.materials.map((m: { name: string }) => m.name)).toEqual(['Rot lackiert.001', 'Default']);
    const material = state().materials[result.materials[0].id];
    expect(Object.keys(material.maps).sort()).toEqual(['baseColor', 'normal', 'roughness']);
    expect(state().textures[material.maps.roughness!].name).toBe('Rot lackiert_metallicRoughness_roughness');
    expect(state().textures[material.maps.roughness!].data).toBe(roughnessPng);
  });

  it('bakes mirrored node transforms into the vertices and fixes the winding', async () => {
    const gltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Parent', scale: [-1, 1, 1], children: [1] }, { name: 'Tri', mesh: 0, translation: [2, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${toBase64(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer))}` }],
    };
    const result = await run('import.file', { format: 'gltf', name: 'tri.gltf', text: JSON.stringify(gltf) });
    const tri = state().objects[result.objects[0].id];
    expect(tri.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(tri.mesh.positions).toEqual([-2, 0, 0, -2, 1, 0, -3, 0, 0]);
    // Still counter-clockwise seen from +Z.
    expect(tri.mesh.faces).toEqual([[0, 1, 2]]);
    expect(state().groups[tri.groupId!].name).toBe('Parent');
    expect(tri.materialId).toBeNull();
  });

  it('round-trips through OBJ, STL and PLY', async () => {
    const built = await buildScene();
    const before = state();
    await run('scene.select', { ids: [built.cube] });
    const world = bakeMesh(before.objects[built.cube].mesh, new Matrix4().compose(new Vector3(1, 2, 3), new Quaternion(0, Math.SQRT1_2, 0, Math.SQRT1_2), new Vector3(1, 2, 1)));
    const expectBox = (mesh: PolyMesh) => {
      close(box(mesh).min, box(world).min);
      close(box(mesh).max, box(world).max);
    };

    const obj = await run('export.file', { format: 'obj', selectionOnly: true });
    const fromObj = await imported({ format: 'obj', name: 'kiste.obj', text: obj.text });
    expect(fromObj.mesh.faces.map((f) => f.length)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(fromObj.mesh.positions).toHaveLength(24);
    expectBox(fromObj.mesh);
    expect(uvByCorner(fromObj.mesh)).toEqual(uvByCorner(world));
    expect(state().materials[fromObj.materialId!].name).toBe('Rot_lackiert');

    await run('scene.select', { ids: [built.cube] });
    const stl = await run('export.file', { format: 'stl', selectionOnly: true });
    const fromStl = await imported({ format: 'stl', name: 'kiste.stl', base64: stl.base64 });
    expect(fromStl.name).toBe('kiste');
    expect(fromStl.mesh.positions).toHaveLength(24);
    expect(fromStl.mesh.faces).toHaveLength(12);
    expect(fromStl.mesh.uvs).toBeUndefined();
    expectBox(fromStl.mesh);

    await run('scene.select', { ids: [built.cube] });
    const ply = await run('export.file', { format: 'ply', selectionOnly: true });
    const fromPly = await imported({ format: 'ply', name: 'kiste.ply', base64: ply.base64 });
    expect(fromPly.mesh.positions).toHaveLength(24);
    expect(fromPly.mesh.faces).toHaveLength(12);
    expectBox(fromPly.mesh);
    const worldUvs = uvByCorner(world);
    for (const [corner, uvs] of uvByCorner(fromPly.mesh)) expect(new Set(worldUvs.get(corner))).toEqual(new Set(uvs));

    // The smooth sphere comes back smooth from PLY (normals) and flat from STL.
    await run('scene.select', { ids: [built.sphere] });
    const spherePly = await run('export.file', { format: 'ply', selectionOnly: true });
    const sphere = await imported({ format: 'ply', name: 's.ply', base64: spherePly.base64 });
    expect(sphere.smooth).toBe(true);
  });

  it('reads OBJ details: negative indices, n-gons, missing UVs, several materials', () => {
    const scene = parseObj(
      ['v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'v 0.5 2 0', 'vt 0 0', 'vt 1 0', 'vt 1 1', 'usemtl a', 'f -5/1 -4/2 -3/3 -2 -1', 'usemtl b', 's 1', 'f 1/1 2/2 3/3', 'f 1 1 2', 'l 1 2'].join('\r\n'),
      'fallback',
    );
    expect(scene.objects.map((o) => [o.name, o.material, o.smooth, o.mesh.faces, o.mesh.uvs])).toEqual([
      ['fallback', 0, false, [[0, 1, 2, 3, 4]], undefined],
      ['fallback', 1, true, [[0, 1, 2]], [[0, 0, 1, 0, 1, 1]]],
    ]);
    expect(() => parseObj('v 0 0\n', 'x')).toThrow('line 1');
    expect(() => parseObj('v 0 0 0\nf 1 2 3\n', 'x')).toThrow('line 2');
    expect(() => parseObj('hello world', 'x')).toThrow('no vertices');
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nl 1 2\n', 'x')).toThrow('no faces');
  });

  it('reads a minimal ASCII FBX through FBXLoader', async () => {
    const fbx = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",1
	}
}
Objects:  {
	Geometry: 1000, "Geometry::Quad", "Mesh" {
		Vertices: *12 {
			a: 0,0,0,100,0,0,100,100,0,0,100,0
		}
		PolygonVertexIndex: *4 {
			a: 0,1,2,-4
		}
		GeometryVersion: 124
		LayerElementNormal: 0 {
			Version: 101
			Name: ""
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			Normals: *12 {
				a: 0,0,1,0,0,1,0,0,1,0,0,1
			}
		}
		LayerElementUV: 0 {
			Version: 101
			Name: "UVMap"
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "IndexToDirect"
			UV: *8 {
				a: 0,0,1,0,1,1,0,1
			}
			UVIndex: *4 {
				a: 0,1,2,3
			}
		}
		Layer: 0 {
			Version: 100
			LayerElement:  {
				Type: "LayerElementNormal"
				TypedIndex: 0
			}
			LayerElement:  {
				Type: "LayerElementUV"
				TypedIndex: 0
			}
		}
	}
	Model: 2000, "Model::Quad", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",200,0,0
		}
	}
	Material: 3000, "Material::Blau", "" {
		Version: 102
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0,0,1
			P: "Shininess", "double", "Number", "",30
		}
	}
}
Connections:  {
	C: "OO",2000,0
	C: "OO",1000,2000
	C: "OO",3000,2000
}
`;
    const result = await run('import.file', { format: 'fbx', name: 'quad.fbx', text: fbx });
    expect(result.objects).toEqual([{ id: expect.any(String), name: 'Quad' }]);
    const quad = state().objects[result.objects[0].id];
    // Centimetres → meters: scale 0.01 on the object, 2 m to the side.
    close(quad.transform.position, [2, 0, 0]);
    close(quad.transform.scale, [0.01, 0.01, 0.01]);
    expect(quad.mesh.positions).toHaveLength(12);
    expect(box(quad.mesh)).toEqual({ min: [0, 0, 0], max: [100, 100, 0] });
    expect(quad.mesh.faces).toHaveLength(2);
    expect(uvByCorner(quad.mesh).get('100.0000,100.0000,0.0000')).toEqual(['1.0000,1.0000', '1.0000,1.0000']);
    expect(quad.smooth).toBe(false);
    const material = state().materials[quad.materialId!];
    expect(material.name).toBe('Blau');
    expect(material.baseColor).toBe('#0000ff');
    expect(material.roughness).toBeCloseTo(0.25);
    expect(result.warnings.join(' ')).toContain('1 cm per unit');
  });

  it('rejects broken input with clear errors and changes nothing', async () => {
    const before = app;
    const cases: [unknown, string][] = [
      [{ format: 'glb', name: 'a.glb', base64: toBase64(new TextEncoder().encode('this is not a glb file at all')) }, 'neither a GLB container nor valid JSON'],
      [{ format: 'glb', name: 'a.glb', base64: 'Z2xURgIAAAD/////' }, 'no JSON chunk'],
      [{ format: 'gltf', name: 'a.gltf', text: '{"asset":{"version":"1.0"}}' }, 'only glTF 2.0'],
      [{ format: 'gltf', name: 'a.gltf', text: '{"asset":{"version":"2.0"},"buffers":[{"uri":"a.bin","byteLength":4}]}' }, 'separate files (a.bin)'],
      [{ format: 'gltf', name: 'a.gltf', text: '{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"]}' }, 'Draco'],
      [{ format: 'gltf', name: 'a.gltf', text: '{"asset":{"version":"2.0"}}' }, 'no scene'],
      [{ format: 'stl', name: 'a.stl', base64: toBase64(new Uint8Array(100).fill(200)) }, 'The STL file could not be read (it may be damaged or not a STL file)'],
      [{ format: 'ply', name: 'a.ply', text: 'solid nothing' }, 'does not start with "ply"'],
      [{ format: 'ply', name: 'a.ply', text: 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n' }, 'point cloud'],
      [{ format: 'obj', name: 'a.obj', text: 'v 1 2 3\n' }, 'no faces'],
      [{ format: 'fbx', name: 'a.fbx', base64: toBase64(new Uint8Array(64).fill(7)) }, 'The FBX file could not be read (it may be damaged or not a FBX file)'],
      [{ format: 'glb', name: 'a.glb', base64: '!!!' }, 'not valid base64'],
      [{ format: 'glb', name: 'a.glb' }, 'either as base64 or as text'],
      [{ format: 'glb', name: 'a.glb', base64: 'AAAA', text: 'x' }, 'either as base64 or as text'],
      [{ format: 'glb', name: 'a.glb', base64: '' }, 'empty'],
    ];
    for (const [params, message] of cases) await expect(run('import.file', params), message).rejects.toThrow(message);
    expect(app).toBe(before);
  });

  it('refuses files above the size limit before parsing', async () => {
    let called = false;
    const guarded: CommandContext = { ...ctx, services: { ...ctx.services, importer: { import: async () => ((called = true), { objects: [], groups: [], materials: [], textures: [], warnings: [] }) } } };
    const text = 'x'.repeat(MAX_IMPORT_BASE64 + 1);
    await expect(runCommand(commandsById.get('import.file')!, guarded, { format: 'obj', name: 'a.obj', text })).rejects.toThrow('too large to import');
    expect(called).toBe(false);
  });
});

describe('addImported', () => {
  const tri: PolyMesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]] };
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } as const;
  const material = { name: 'M', baseColor: '#ffffff', metallic: 0, roughness: 0.5, emissive: '#000000', emissiveStrength: 1, normalScale: 1 };

  it('rewires references, skips bad textures and empty groups, clamps bad material values', () => {
    const scene: ImportedScene = {
      objects: [
        { name: '', mesh: tri, transform: { ...transform } as never, smooth: false, material: 0, group: 1 },
        { name: 'empty', mesh: { positions: [], faces: [] }, transform: { ...transform } as never, smooth: false, material: null, group: 2 },
      ],
      groups: [
        { name: 'Root', parent: null },
        { name: 'Child', parent: 0 },
        { name: 'Unused', parent: null },
      ],
      materials: [{ ...material, baseColor: 'red', roughness: 7, maps: { baseColor: 0, normal: 1, roughness: 5 } }],
      textures: [
        { name: 'ok', mimeType: 'image/png', data: png(1, 1), width: 1, height: 1 },
        { name: 'bad', mimeType: 'image/png', data: 'AAAA', width: 1, height: 1 },
      ],
      warnings: ['from the importer'],
    };
    const { state: next, result } = addImported(emptyDocState, scene, 'file');
    expect(result.objects).toEqual([{ id: expect.any(String), name: 'file' }]);
    expect(result.groups.map((g) => g.name)).toEqual(['Root', 'Child']);
    expect(result.textures.map((t) => t.name)).toEqual(['ok']);
    expect(result.warnings).toEqual(['from the importer', 'Skipped the texture "bad": not a valid image file']);
    const object = next.objects[result.objects[0].id];
    expect(next.groups[object.groupId!].name).toBe('Child');
    expect(next.groups[next.groups[object.groupId!].parentId!].name).toBe('Root');
    const added = next.materials[object.materialId!];
    expect(added.baseColor).toBe('#b9b5ae');
    expect(added.roughness).toBe(0.6);
    expect(added.maps).toEqual({ baseColor: result.textures[0].id });
    expect(next.selection).toEqual([object.id]);
    expect(next.activeId).toBe(object.id);
    expect(next.groupOrder).toHaveLength(2);
  });

  it('throws when there is no mesh', () => {
    expect(() => addImported(emptyDocState, { objects: [], groups: [], materials: [], textures: [], warnings: [] }, 'x')).toThrow('no meshes');
  });
});
