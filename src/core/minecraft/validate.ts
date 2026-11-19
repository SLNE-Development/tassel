// Checks a Minecraft Java model for what the game would reject or show wrongly (like Blockbench's validator).
import { cuboidFaces } from '../types';
import type { DocState } from '../types';
import { modelBox } from './cuboid';
import { capabilities } from './versions';

export interface JavaIssue {
  severity: 'error' | 'warning';
  /** English, for MCP clients; the UI translates by `code`. */
  message: string;
  code: 'texture_name' | 'texture_namespace' | 'texture_folder' | 'zero_uv' | 'out_of_range' | 'rotation' | 'missing_texture' | 'generated_with_elements';
  /** The element or texture the issue is about. */
  objectId?: string;
  textureId?: string;
}

const NAME = /^[a-z0-9._/-]+$/;
const NAMESPACE = /^[a-z0-9._-]+$/;

export function validateJavaModel(state: DocState): JavaIssue[] {
  const java = state.java;
  if (!java) return [];
  const caps = capabilities(java.version);
  const issues: JavaIssue[] = [];
  for (const texture of Object.values(state.textures)) {
    const ref = texture.java;
    if (!NAME.test(texture.name)) {
      issues.push({ severity: 'error', code: 'texture_name', textureId: texture.id, message: `Texture name "${texture.name}" may only contain a-z, 0-9, ".", "_", "-" and "/"` });
    }
    if (ref && !NAMESPACE.test(ref.namespace)) {
      issues.push({ severity: 'error', code: 'texture_namespace', textureId: texture.id, message: `Namespace "${ref.namespace}" of texture "${texture.name}" may only contain a-z, 0-9, ".", "_" and "-"` });
    }
    if (ref && ref.folder !== '' && !NAME.test(ref.folder)) {
      issues.push({ severity: 'error', code: 'texture_folder', textureId: texture.id, message: `Folder "${ref.folder}" of texture "${texture.name}" may only contain a-z, 0-9, ".", "_", "-" and "/"` });
    }
  }
  const [lo, hi] = caps.coordinateRange;
  let elements = 0;
  for (const id of state.order) {
    const obj = state.objects[id];
    if (!obj.cuboid || !obj.cuboid.export) continue;
    elements++;
    const { from, to } = modelBox({ ...obj, cuboid: obj.cuboid });
    const inflate = obj.cuboid.inflate;
    if ([...from.map((v) => v - inflate), ...to.map((v) => v + inflate)].some((v) => v < lo || v > hi)) {
      issues.push({ severity: 'error', code: 'out_of_range', objectId: id, message: `Element "${obj.name}" reaches outside ${lo}..${hi} px, which Minecraft does not allow` });
    }
    const rotated = obj.transform.rotation.filter((r) => r !== 0);
    if (!caps.freeRotation && (rotated.length > 1 || rotated.some((r) => Math.abs(r) > caps.rotationLimit || (caps.rotationStep > 0 && r % caps.rotationStep !== 0)))) {
      issues.push({ severity: 'error', code: 'rotation', objectId: id, message: `Element "${obj.name}" has a rotation that Minecraft ${java.version} cannot express` });
    }
    for (const name of cuboidFaces) {
      const face = obj.cuboid.faces[name];
      if (!face.enabled) continue;
      if (face.uv[0] === face.uv[2] || face.uv[1] === face.uv[3]) {
        issues.push({ severity: 'warning', code: 'zero_uv', objectId: id, message: `Face ${name} of element "${obj.name}" has a UV area of zero width or height` });
      }
      if (face.texture === null) {
        issues.push({ severity: 'warning', code: 'missing_texture', objectId: id, message: `Face ${name} of element "${obj.name}" has no texture and shows as missing` });
      }
    }
  }
  if (elements > 0 && /(^|:)(item\/generated|builtin\/generated)$/.test(java.parent)) {
    issues.push({ severity: 'warning', code: 'generated_with_elements', message: `The parent "${java.parent}" generates the model from its textures; Minecraft ignores the elements` });
  }
  return issues;
}
