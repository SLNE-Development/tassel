import { z } from 'zod';
import { MAX_TEXTURE_BASE64, MAX_TEXTURE_SIZE, textureBytes, textureDataProblem, textureUsers } from '../materials';
import { newId, uniqueName } from '../state';
import { textureMimeTypes, textureSlots } from '../types';
import type { DocState, Texture } from '../types';
import { defineCommand, docState, updateDocState } from './registry';

function requireTexture(state: DocState, id: string): Texture {
  const texture = state.textures[id];
  if (!texture) throw new Error(`Texture "${id}" does not exist`);
  return texture;
}

function textureNames(state: DocState, exceptId?: string): string[] {
  return Object.values(state.textures)
    .filter((t) => t.id !== exceptId)
    .map((t) => t.name);
}

/** Everything about a texture except its data. */
function summary(state: DocState, texture: Texture) {
  return {
    id: texture.id,
    name: texture.name,
    mimeType: texture.mimeType,
    width: texture.width,
    height: texture.height,
    bytes: textureBytes(texture.data),
    usedBy: textureUsers(state.materials, texture.id),
  };
}

const megabytes = (chars: number) => (chars / (1024 * 1024)).toFixed(1);
const pixels = z.number().int().min(1).max(MAX_TEXTURE_SIZE);

export const textureCommands = [
  defineCommand({
    id: 'texture.add',
    title: 'Textur hinzufügen',
    description: `Embed an image in the active document as a texture. data is the encoded image file (PNG, JPEG or WebP, matching mimeType) as base64 without a "data:" prefix, at most ${megabytes(MAX_TEXTURE_BASE64)} MB of base64; width and height are its size in pixels (1..${MAX_TEXTURE_SIZE}). To load an image from disk use the file_import tool, which decodes it and calls this. The texture shows up once a material uses it: material.update { id, maps: { baseColor: textureId } }. Names are made unique among all textures. Returns the new texture id.`,
    params: z.object({
      name: z.string().min(1),
      mimeType: z.enum(textureMimeTypes),
      data: z.string().describe('The image file as base64 (no data: prefix)'),
      width: pixels,
      height: pixels,
    }),
    run(ctx, p) {
      const problem = textureDataProblem(p.mimeType, p.data);
      if (problem === 'empty') throw new Error('Texture data is empty');
      if (problem === 'tooLarge') {
        throw new Error(
          `Texture data is too large: ${megabytes(p.data.length)} MB of base64, the limit is ${megabytes(MAX_TEXTURE_BASE64)} MB. Use a smaller or more compressed image.`,
        );
      }
      if (problem === 'notBase64') throw new Error('Texture data is not valid base64 (expected the padded standard alphabet without a data: prefix)');
      if (problem === 'signature') throw new Error(`Texture data is not a ${p.mimeType} file (wrong file signature)`);
      const state = docState(ctx);
      // The data string is stored as given; all history states share this one texture object.
      const texture: Texture = {
        id: newId(),
        name: uniqueName(textureNames(state), p.name),
        mimeType: p.mimeType,
        data: p.data,
        width: p.width,
        height: p.height,
      };
      updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [texture.id]: texture } }));
      return { id: texture.id, name: texture.name };
    },
  }),

  defineCommand({
    id: 'texture.remove',
    title: 'Textur entfernen',
    description:
      'Remove a texture from the document and clear it from every material slot that used it. Returns those slots as clearedFrom.',
    params: z.object({ id: z.string() }),
    run(ctx, p) {
      const state = docState(ctx);
      requireTexture(state, p.id);
      const users = textureUsers(state.materials, p.id);
      updateDocState(ctx, (s) => {
        const textures = { ...s.textures };
        delete textures[p.id];
        const materials = { ...s.materials };
        for (const { materialId } of users) {
          const maps = { ...materials[materialId].maps };
          for (const slot of textureSlots) if (maps[slot] === p.id) delete maps[slot];
          materials[materialId] = { ...materials[materialId], maps };
        }
        return { ...s, textures, materials };
      });
      return { removed: p.id, clearedFrom: users };
    },
  }),

  defineCommand({
    id: 'texture.rename',
    title: 'Textur umbenennen',
    description: 'Rename a texture. Names are made unique among all textures by appending .001, .002, ...',
    params: z.object({ id: z.string(), name: z.string().min(1) }),
    run(ctx, p) {
      const state = docState(ctx);
      requireTexture(state, p.id);
      const name = uniqueName(textureNames(state, p.id), p.name);
      updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [p.id]: { ...s.textures[p.id], name } } }));
      return { id: p.id, name };
    },
  }),

  defineCommand({
    id: 'texture.list',
    title: 'Texturen auflisten',
    description:
      'All textures of the active document: id, name, mimeType, width and height in pixels, bytes (size of the image file) and usedBy (the material slots using it). The image data itself is not included; texture.get returns it.',
    params: z.object({}),
    run(ctx) {
      const state = docState(ctx);
      return { textures: Object.values(state.textures).map((texture) => summary(state, texture)) };
    },
  }),

  defineCommand({
    id: 'texture.get',
    title: 'Textur abfragen',
    description:
      'Get one texture including data, the whole image file as base64. WARNING: data can be many megabytes and will flood your context; this command is meant for exporters. Use texture.list for everything except the pixels, and view_screenshot to see how a texture looks on an object.',
    params: z.object({ id: z.string() }),
    run(ctx, p) {
      const state = docState(ctx);
      const texture = requireTexture(state, p.id);
      return { ...summary(state, texture), data: texture.data };
    },
  }),
];
