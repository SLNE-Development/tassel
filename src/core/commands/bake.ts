import { z } from 'zod';
import { defaultMaterial, textureDataProblem } from '../materials';
import { evaluateObject } from '../modifiers/evaluate';
import { newId, own, uniqueName } from '../state';
import type { BakeOutput, BakeRequest, DocState, Material, SceneObject, Texture, TextureSlot } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

function requireObject(state: DocState, id: string, role: string): SceneObject {
  const object = own(state.objects, id);
  if (!object) throw new Error(`${role} object "${id}" does not exist`);
  return object;
}

/** The target of a bake: it must exist and its evaluated mesh must have UVs. */
function requireTarget(state: DocState, id: string): SceneObject {
  const target = requireObject(state, id, 'Target');
  const mesh = evaluateObject(state, id).mesh;
  if (mesh.faces.length === 0) throw new Error(`The target object "${target.name}" has no faces`);
  if (!mesh.uvs) {
    throw new Error(
      target.mesh.uvs
        ? `The target object "${target.name}" loses its UVs in its modifiers (a boolean modifier does that). Apply the modifier and unwrap the object again (uv.unwrap) before baking.`
        : `The target object "${target.name}" has no UVs. Unwrap it first (uv.unwrap), then bake.`,
    );
  }
  return target;
}

/**
 * Adds the baked image as a new texture and, with `assign`, puts it into `slot` of the target's
 * material (a new material if the target has none). One state update, so one undo step.
 */
function storeResult(ctx: CommandContext, output: BakeOutput, size: number, targetId: string, name: string, slot: TextureSlot, assign: boolean) {
  if (textureDataProblem('image/png', output.data)) throw new Error('Baking produced no valid image');
  // The document as it is now: the bake took a while and the user may have kept working.
  const state = docState(ctx);
  const texture: Texture = {
    id: newId(),
    name: uniqueName(
      Object.values(state.textures).map((t) => t.name),
      name,
    ),
    mimeType: 'image/png',
    data: output.data,
    width: size,
    height: size,
  };
  const target = own(state.objects, targetId);
  let materialId: string | null = null;
  let material: Material | null = null;
  if (assign && target) {
    const current = target.materialId === null ? undefined : own(state.materials, target.materialId);
    material = current
      ? { ...current, maps: { ...current.maps, [slot]: texture.id } }
      : {
          id: newId(),
          name: uniqueName(
            Object.values(state.materials).map((m) => m.name),
            target.name,
          ),
          ...defaultMaterial,
          maps: { [slot]: texture.id },
        };
    materialId = material.id;
  }
  updateDocState(ctx, (s) => ({
    ...s,
    textures: { ...s.textures, [texture.id]: texture },
    materials: material ? { ...s.materials, [material.id]: material } : s.materials,
    objects: material && target && target.materialId !== material.id ? { ...s.objects, [targetId]: { ...s.objects[targetId], materialId: material.id } } : s.objects,
  }));
  return { textureId: texture.id, name: texture.name, materialId };
}

async function bake(ctx: CommandContext, request: BakeRequest): Promise<BakeOutput> {
  if (!ctx.services.baker) throw new Error('The baker is not ready yet');
  return ctx.services.baker.bake(docState(ctx), request);
}

const size = z.number().int().min(16).max(8192).default(1024).describe('Width and height of the texture in pixels (square), 16..8192. 1024 or 2048 is usual.');
const assign = z.boolean().default(true);
const common =
  'Geometry is taken as displayed: after modifiers, in world space, so place the objects where they belong before baking. The target needs UVs without overlaps (uv.unwrap; overlapping parts share texels). The charts are extended by 8 texels into the empty space around them so that texture filtering shows no seams. Baking runs in the background and takes from under a second to minutes (it grows with size x size, the triangle count of the objects, and for ambient occlusion with samples); the command returns when it is done. The result is a new PNG texture in the document; baking again creates another one (texture.remove deletes old ones).';

export const bakeCommands = [
  defineCommand({
    id: 'bake.normal',
    title: 'Normal-Map backen',
    description: `Bake the surface detail of high-poly source objects into a tangent-space normal map for a low-poly target object, so that the target looks as detailed as the sources. For every texel of the target a ray is cast from its surface along the interpolated smooth vertex normal, outwards and inwards, up to maxDistance; the nearest source surface that faces the same way supplies its shading normal (smooth or flat, as the source is shaded; where sources run through each other, e.g. a bump pushed into a body, the outer, visible surface is taken instead of one buried inside another source), which is stored relative to the target's tangent frame (OpenGL convention, green = +v, as glTF and the viewport use). The sources must sit where the target is (same place and size, the usual high-poly / low-poly pair). The target's frame is always built from SMOOTH normals, whatever its shading is set to: set the target to smooth shading (scene.set_smooth) to see the result as baked; on a flat-shaded target the lighting will look wrong along the facets. maxDistance defaults to 5 % of the target's bounding diagonal; coverage in the result is the share of the target's texels that found a source — if it is clearly below 1, the sources are further away than maxDistance (raise it) or do not cover the target; texels that found nothing stay flat (128, 128, 255). With assign (default) the texture goes into the normal slot of the target's material (a new material named like the target if it has none; other objects sharing that material get the map too), all as one undo step. ${common} Returns { textureId, name, coverage, maxDistance, materialId }.`,
    params: z.object({
      targetId: z.string().describe('The low-poly object that gets the normal map. Needs UVs.'),
      sourceIds: z.array(z.string()).min(1).describe('The high-poly objects whose surface detail is baked.'),
      size,
      maxDistance: z.number().positive().optional().describe('How far from the target surface a source is searched, in meters (world space). Default: 5 % of the target bounding diagonal.'),
      name: z.string().min(1).optional().describe('Name of the new texture. Default: "<target name> Normal".'),
      assign: assign.describe('Put the texture into the normal slot of the target material.'),
    }),
    async run(ctx, p) {
      const state = docState(ctx);
      const target = requireTarget(state, p.targetId);
      const sourceIds = [...new Set(p.sourceIds)];
      for (const id of sourceIds) {
        const source = requireObject(state, id, 'Source');
        if (id === p.targetId) throw new Error('The target cannot be its own source: baking an object onto itself gives a flat normal map');
        if (evaluateObject(state, id).mesh.faces.length === 0) throw new Error(`The source object "${source.name}" has no faces`);
      }
      const output = await bake(ctx, { type: 'normal', targetId: p.targetId, sourceIds, size: p.size, maxDistance: p.maxDistance });
      const stored = storeResult(ctx, output, p.size, p.targetId, p.name ?? `${target.name} Normal`, 'normal', p.assign);
      return { ...stored, coverage: output.coverage, maxDistance: output.distance };
    },
  }),

  defineCommand({
    id: 'bake.ao',
    title: 'Umgebungsverdeckung backen',
    description: `Bake ambient occlusion for an object into a greyscale texture: white where the surface sees the open surroundings, darker in creases, corners and where other objects are close. For every texel of the target, samples rays (cosine-weighted, the same deterministic set for every run) are cast into the hemisphere above the surface up to distance; the texel is the share of rays that hit nothing. Occluders are the target itself plus the objects in includeIds (e.g. the floor it stands on); other objects are ignored. distance defaults to 25 % of the bounding diagonal of the target and the included objects: smaller values keep the darkening close to creases and contacts, larger ones give broad soft shading. More samples give less noise (64 is good, 256 very clean) and take proportionally longer. The hemisphere follows the target's shading (smooth or flat). With assign (default) the texture goes into the occlusion slot of the target's material (a new material named like the target if it has none; other objects sharing that material get the map too), all as one undo step; the viewport shows occlusion in material shading, where it darkens the ambient light. ${common} Returns { textureId, name, distance, materialId }.`,
    params: z.object({
      targetId: z.string().describe('The object that gets the occlusion map. Needs UVs.'),
      size,
      samples: z.number().int().min(1).max(4096).default(64).describe('Rays per texel.'),
      distance: z.number().positive().optional().describe('Maximum ray length in meters (world space): only surfaces closer than this darken a texel. Default: 25 % of the bounding diagonal of the target and the included objects.'),
      includeIds: z.array(z.string()).default([]).describe('Other objects that cast occlusion onto the target.'),
      name: z.string().min(1).optional().describe('Name of the new texture. Default: "<target name> AO".'),
      assign: assign.describe('Put the texture into the occlusion slot of the target material.'),
    }),
    async run(ctx, p) {
      const state = docState(ctx);
      const target = requireTarget(state, p.targetId);
      const includeIds = [...new Set(p.includeIds)].filter((id) => id !== p.targetId);
      for (const id of includeIds) requireObject(state, id, 'Included');
      const output = await bake(ctx, { type: 'ao', targetId: p.targetId, includeIds, size: p.size, samples: p.samples, distance: p.distance });
      const stored = storeResult(ctx, output, p.size, p.targetId, p.name ?? `${target.name} AO`, 'occlusion', p.assign);
      return { ...stored, distance: output.distance };
    },
  }),
];
