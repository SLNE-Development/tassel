// Wavefront OBJ (+ MTL). Hand-written: polygons stay polygons and UVs stay per face corner, which
// three's OBJ classes would turn into triangle soup.
import { defaultMaterial } from '../core/materials';
import { faceNormal } from '../core/mesh/polymesh';
import type { DocState, ExportResult, ImportedScene, Material, PolyMesh, Texture, TextureSlot } from '../core/types';
import { FileError } from './bytes';
import { sanitizeFileName, uniqueFileName } from './names';
import { fallbackMaterial, hexToRgb, vertexNormals, worldMesh, type ExportItem } from './scene';

/** Up to six decimals (a micrometre), without trailing zeros or "-0". */
const num = (x: number) => String(Number(x.toFixed(6)) || 0);

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

const EXTENSIONS: Record<Texture['mimeType'], string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/** MTL statement per texture slot. `map_Pr` / `map_Pm` are the PBR extension Blender and others read. */
const MAP_STATEMENTS: Record<TextureSlot, string> = {
  baseColor: 'map_Kd',
  roughness: 'map_Pr',
  metallic: 'map_Pm',
  emissive: 'map_Ke',
  occlusion: 'map_Ka',
  normal: 'map_Bump',
};

/**
 * Writes all items into one OBJ in world space (OBJ has no transforms). `name` is the file name without
 * extension; the material library and the texture images are named after it.
 */
export function writeObj(state: DocState, items: readonly ExportItem[], name: string): Required<Pick<ExportResult, 'text' | 'mtl' | 'mtlName' | 'files'>> {
  const stem = sanitizeFileName(name, 'model');
  const mtlName = `${stem}.mtl`;
  const out: string[] = ['# Tessel OBJ export. Y up, meters.', `mtllib ${mtlName}`];

  const materialNames = new Map<Material, string>();
  const noted = new Set<Material>();
  const takenMaterials = new Set<string>();
  const nameOf = (material: Material) => {
    let known = materialNames.get(material);
    if (!known) {
      known = uniqueFileName(takenMaterials, sanitizeFileName(material.name, 'material'));
      materialNames.set(material, known);
    }
    return known;
  };

  // OBJ indices count through the whole file, starting at 1.
  let vBase = 1;
  let vtBase = 1;
  let vnBase = 1;
  for (const item of items) {
    const mesh = worldMesh(item);
    out.push(`o ${oneLine(item.name) || 'object'}`);
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) out.push(`v ${num(p[i])} ${num(p[i + 1])} ${num(p[i + 2])}`);

    // Texture coordinates and normals are shared where their written values are equal.
    const vtIndex = new Map<string, number>();
    const vnIndex = new Map<string, number>();
    const vtLines: string[] = [];
    const vnLines: string[] = [];
    const intern = (index: Map<string, number>, lines: string[], line: string) => {
      let i = index.get(line);
      if (i === undefined) {
        i = lines.length;
        index.set(line, i);
        lines.push(line);
      }
      return i;
    };
    const smoothNormals = item.smooth ? vertexNormals(mesh) : null;
    const faceLines = mesh.faces.map((face, f) => {
      const flat = smoothNormals ? null : faceNormal(mesh, face);
      const flatIndex = flat && intern(vnIndex, vnLines, `vn ${num(flat[0])} ${num(flat[1])} ${num(flat[2])}`);
      const uv = mesh.uvs?.[f];
      const corners = face.map((v, c) => {
        const vt = uv ? String(vtBase + intern(vtIndex, vtLines, `vt ${num(uv[c * 2])} ${num(uv[c * 2 + 1])}`)) : '';
        const vn =
          flatIndex ??
          intern(vnIndex, vnLines, `vn ${num(smoothNormals![v * 3])} ${num(smoothNormals![v * 3 + 1])} ${num(smoothNormals![v * 3 + 2])}`);
        return `${vBase + v}/${vt}/${vnBase + vn}`;
      });
      return `f ${corners.join(' ')}`;
    });
    // No spreads: a large mesh has more lines than a call can take arguments.
    for (const line of vtLines) out.push(line);
    for (const line of vnLines) out.push(line);
    // Material names lose their spaces in OBJ; this comment keeps the real name for Tessel's importer.
    // Likewise the stand-in for "no material" is marked, so that it does not come back as a material.
    if (!noted.has(item.material) && (item.material === fallbackMaterial || nameOf(item.material) !== item.material.name)) {
      noted.add(item.material);
      out.push(item.material === fallbackMaterial ? `# tessel:no-material ${nameOf(item.material)}` : `# tessel:material ${nameOf(item.material)} ${oneLine(item.material.name)}`);
    }
    out.push(`usemtl ${nameOf(item.material)}`, `s ${item.smooth ? '1' : 'off'}`);
    for (const line of faceLines) out.push(line);
    vBase += p.length / 3;
    vtBase += vtLines.length;
    vnBase += vnLines.length;
  }

  // --- Material library and the images it refers to ----------------------------------------------
  const files: { name: string; base64: string }[] = [];
  const takenFiles = new Set<string>([`${stem}.obj`.toLowerCase(), mtlName.toLowerCase()]);
  const fileOf = new Map<string, string>();
  const imageFile = (texture: Texture) => {
    let file = fileOf.get(texture.id);
    if (!file) {
      file = uniqueFileName(takenFiles, `${stem}_${sanitizeFileName(texture.name.replace(/\.(png|jpe?g|webp)$/i, ''), 'texture')}`, EXTENSIONS[texture.mimeType]);
      fileOf.set(texture.id, file);
      files.push({ name: file, base64: texture.data });
    }
    return file;
  };
  const mtl: string[] = ['# Tessel MTL export. Colours are sRGB; Pr / Pm / map_Pr / map_Pm are the PBR extension.'];
  for (const [material, mtlMaterial] of materialNames) {
    const emissive = hexToRgb(material.emissive).map((c) => num(c * material.emissiveStrength));
    mtl.push(
      '',
      `newmtl ${mtlMaterial}`,
      `Kd ${hexToRgb(material.baseColor).map(num).join(' ')}`,
      'Ks 0.5 0.5 0.5',
      // The classic specular exponent, for readers that do not know Pr.
      `Ns ${num((1 - material.roughness) ** 2 * 1000)}`,
      `Ke ${emissive.join(' ')}`,
      'd 1',
      `illum ${material.metallic > 0 ? 3 : 2}`,
      `Pr ${num(material.roughness)}`,
      `Pm ${num(material.metallic)}`,
    );
    for (const slot of Object.keys(MAP_STATEMENTS) as TextureSlot[]) {
      const id = material.maps[slot];
      const texture = id !== undefined ? state.textures[id] : undefined;
      if (!texture) continue;
      const options = slot === 'normal' ? `-bm ${num(material.normalScale)} ` : '';
      mtl.push(`${MAP_STATEMENTS[slot]} ${options}${imageFile(texture)}`);
    }
  }

  return { text: out.join('\n') + '\n', mtl: mtl.join('\n') + '\n', mtlName, files };
}

interface Part {
  name: string;
  material: string | null;
  smooth: boolean;
  positions: number[];
  /** Vertex index in the file → index in `positions` / 3. */
  local: Map<number, number>;
  faces: number[][];
  uvs: number[][];
  /** False as soon as one face has a corner without a texture coordinate. */
  hasUvs: boolean;
}

/**
 * Reads an OBJ file: one object per `o` / `g` section and material. Polygons and per-corner UVs are kept.
 * The material library is a separate file a single-file import cannot see, so materials come in by name
 * only (default values), which keeps the assignment.
 */
export function parseObj(text: string, fallbackName: string): ImportedScene {
  const v: number[] = [];
  const vt: number[] = [];
  const parts = new Map<string, Part>();
  const realNames = new Map<string, string>();
  const noMaterial = new Set<string>();
  const warnings: string[] = [];
  let objectName = fallbackName;
  let materialName: string | null = null;
  let smooth = false;
  let part: Part | null = null;
  let faceLines = 0;

  const currentPart = () => {
    if (part) return part;
    const key = `${objectName}\u0000${materialName ?? ''}`;
    part = parts.get(key) ?? null;
    if (!part) {
      part = { name: objectName, material: materialName, smooth: false, positions: [], local: new Map(), faces: [], uvs: [], hasUvs: true };
      parts.set(key, part);
    }
    return part;
  };

  let lineStart = 0;
  let lineNumber = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd).trim();
    lineStart = lineEnd + 1;
    lineNumber++;
    if (line.startsWith('# tessel:material ')) {
      // Written by Tessel's exporter: the material's real name for the space-free one in `usemtl`.
      const [written, ...real] = line.slice('# tessel:material '.length).trim().split(/\s+/);
      if (written && real.length > 0) realNames.set(written, real.join(' '));
      continue;
    }
    if (line.startsWith('# tessel:no-material ')) {
      noMaterial.add(line.slice('# tessel:no-material '.length).trim());
      continue;
    }
    if (line === '' || line[0] === '#') continue;
    const space = line.search(/\s/);
    const keyword = space === -1 ? line : line.slice(0, space);
    const rest = space === -1 ? '' : line.slice(space + 1).trim();
    switch (keyword) {
      case 'v':
      case 'vt': {
        const values = rest.split(/\s+/).map(Number);
        const count = keyword === 'v' ? 3 : 2;
        // A texture coordinate may have only u.
        if (keyword === 'vt' && values.length === 1) values.push(0);
        if (values.length < count || values.slice(0, count).some((n) => !Number.isFinite(n))) {
          throw new FileError(`Invalid OBJ file: line ${lineNumber} is not a valid "${keyword}" statement`);
        }
        (keyword === 'v' ? v : vt).push(...values.slice(0, count));
        break;
      }
      case 'f': {
        faceLines++;
        const target = currentPart();
        const face: number[] = [];
        const uv: number[] = [];
        let cornerHasUv = true;
        for (const corner of rest.split(/\s+/)) {
          const [vText, vtText] = corner.split('/');
          let vi = parseInt(vText, 10);
          // Negative indices count back from the last vertex read so far.
          vi = vi < 0 ? v.length / 3 + vi : vi - 1;
          if (!Number.isInteger(vi) || vi < 0 || vi >= v.length / 3) {
            throw new FileError(`Invalid OBJ file: the face in line ${lineNumber} refers to a vertex that does not exist`);
          }
          let index = target.local.get(vi);
          if (index === undefined) {
            index = target.positions.length / 3;
            target.local.set(vi, index);
            target.positions.push(v[vi * 3], v[vi * 3 + 1], v[vi * 3 + 2]);
          }
          // Skip a corner that repeats the previous vertex.
          if (face[face.length - 1] === index) continue;
          face.push(index);
          let ti = vtText ? parseInt(vtText, 10) : NaN;
          ti = ti < 0 ? vt.length / 2 + ti : ti - 1;
          if (Number.isInteger(ti) && ti >= 0 && ti < vt.length / 2) uv.push(vt[ti * 2], vt[ti * 2 + 1]);
          else cornerHasUv = false;
        }
        if (face.length > 1 && face[0] === face[face.length - 1]) {
          face.pop();
          uv.length = Math.min(uv.length, face.length * 2);
        }
        if (face.length < 3 || new Set(face).size !== face.length) break;
        target.faces.push(face);
        target.uvs.push(uv);
        if (!cornerHasUv) target.hasUvs = false;
        if (smooth) target.smooth = true;
        break;
      }
      case 'o':
      case 'g':
        objectName = rest || fallbackName;
        part = null;
        break;
      case 'usemtl':
        materialName = rest || null;
        part = null;
        break;
      case 's':
        smooth = rest !== 'off' && rest !== '0' && rest !== '';
        break;
      case 'mtllib':
        warnings.push(
          `The materials of this OBJ are in the separate file "${rest}", which a single-file import does not read. Materials were created by name with default values; textures were not imported.`,
        );
        break;
      default:
        break;
    }
  }
  if (v.length === 0) throw new FileError('Invalid OBJ file: it contains no vertices');
  if (faceLines === 0) throw new FileError('The OBJ file contains no faces (only points or lines), so there is nothing to import');

  const scene: ImportedScene = { objects: [], groups: [], materials: [], textures: [], warnings };
  const materialIndex = new Map<string, number>();
  for (const p of parts.values()) {
    if (p.faces.length === 0) continue;
    let material: number | null = null;
    if (p.material !== null && !noMaterial.has(p.material)) {
      material = materialIndex.get(p.material) ?? scene.materials.push({ ...defaultMaterial, name: realNames.get(p.material) ?? p.material, maps: {}, nameOnly: true }) - 1;
      materialIndex.set(p.material, material);
    }
    const mesh: PolyMesh = p.hasUvs ? { positions: p.positions, faces: p.faces, uvs: p.uvs } : { positions: p.positions, faces: p.faces };
    scene.objects.push({
      name: p.name,
      mesh,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      smooth: p.smooth,
      material,
      group: null,
    });
  }
  return scene;
}
