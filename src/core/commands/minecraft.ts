import { z } from 'zod';
import { MISSING_TEXTURE_PNG } from '../minecraft/javaImport';
import { openJavaModelWithParents, parentModes } from '../minecraft/openModel';
import { inheritedSummary } from '../minecraft/parents';
import { refreshParent } from './minecraftParents';
import { exportJavaModel, textureLocation } from '../minecraft/javaExport';
import { pxVec3, textureSizeSchema } from '../minecraft/schema';
import { validateJavaModel } from '../minecraft/validate';
import { capabilities, isJavaVersion, javaVersions } from '../minecraft/versions';
import { resolveGroupId } from '../refs';
import { addDoc, createDoc, own, uniqueName } from '../state';
import { guiLights } from '../types';
import type { DocState, JavaModelSettings } from '../types';
import { resolveTextureId } from './cuboid';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

function requireJava(state: DocState): JavaModelSettings {
  if (!state.java) throw new Error('The document is not a Minecraft Java model');
  return state.java;
}

function settingsResult(state: DocState) {
  const java = requireJava(state);
  const particle = java.particle !== null ? own(state.textures, java.particle) : undefined;
  // The parent snapshot carries images; only its summary is reported.
  const { inherited: _inherited, ...rest } = java;
  return {
    ...rest,
    inherited: inheritedSummary(state),
    particle: particle ? { id: particle.id, name: particle.name, location: textureLocation(particle) } : null,
    versions: javaVersions.map((v) => v.id),
    capabilities: capabilities(java.version),
  };
}

function updateJava(ctx: CommandContext, update: (java: JavaModelSettings) => JavaModelSettings) {
  updateDocState(ctx, (s) => ({ ...s, java: update(requireJava(s)) }));
}

export const minecraftCommands = [
  defineCommand({
    id: 'minecraft.get_settings',
    title: 'Modelleinstellungen abfragen',
    description:
      'Get the settings of a Minecraft Java model: version (target Minecraft version), fileName (model file name without .json), parent, ambientOcclusion, guiLight ("side", "front" or null = not written), textureSize ([w, h], the UV size), credit, particle (the particle texture or null), display (as read from a file) and extra (unknown keys of an imported file, written back on export), plus the known versions and what the target version can express (capabilities).',
    params: z.object({}),
    history: false,
    run(ctx) {
      return settingsResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'minecraft.set_settings',
    title: 'Modelleinstellungen ändern',
    description:
      'Change settings of a Minecraft Java model; only the given fields change. parent: e.g. "block/block" or "item/generated" ("" = none). textureSize [w, h]: the UV size - face UVs keep their numbers, so they now cover a different part of the texture. particle: a texture (id, name or variable) or null. version: the target version (see minecraft_get_settings).',
    params: z.object({
      fileName: z.string().min(1).optional(),
      parent: z.string().optional(),
      ambientOcclusion: z.boolean().optional(),
      guiLight: z.enum(guiLights).nullable().optional(),
      textureSize: textureSizeSchema.optional(),
      credit: z.string().optional(),
      particle: z.string().nullable().optional(),
      version: z.string().optional(),
    }),
    async run(ctx, p) {
      const state = docState(ctx);
      if (p.version !== undefined && !isJavaVersion(p.version)) {
        throw new Error(`Unknown Minecraft Java version "${p.version}". Known: ${javaVersions.map((v) => v.id).join(', ')}`);
      }
      const particle = p.particle === undefined ? undefined : p.particle === null ? null : resolveTextureId(state, p.particle);
      const { particle: _p, ...rest } = p;
      const set = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const parentChanged = p.parent !== undefined && p.parent !== state.java?.parent;
      updateJava(ctx, (java) => {
        const next = { ...java, ...set, ...(particle !== undefined ? { particle } : {}) };
        // A snapshot of the old parent chain no longer applies.
        if (!parentChanged || !next.inherited) return next;
        const { inherited: _old, ...without } = next;
        return without;
      });
      // It was shown: show the new parent instead.
      if (parentChanged && state.java?.inherited && p.parent) await refreshParent(ctx).catch(() => undefined);
      return settingsResult(docState(ctx));
    },
  }),

  defineCommand({
    id: 'minecraft.set_texture',
    title: 'Texturpfad setzen',
    description:
      'Set where a texture of a Minecraft Java model lives: namespace (e.g. "minecraft" or your mod id), folder (e.g. "block" or "item/tools"; "" = directly under textures/), key (the texture variable faces refer to as "#key"; unique in the model) and name (the file name without .png). The model refers to it as "namespace:folder/name" (namespace left out for minecraft). Returns the texture with its location.',
    params: z.object({
      texture: z.string().describe('Texture id, name or variable.'),
      namespace: z.string().min(1).optional(),
      folder: z.string().optional(),
      key: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const id = resolveTextureId(state, p.texture);
      const texture = state.textures[id];
      if (p.key !== undefined && p.key !== texture.java?.key && Object.values(state.textures).some((t) => t.java?.key === p.key)) {
        throw new Error(`The texture variable "${p.key}" is already used by another texture`);
      }
      if (p.key === 'particle' || p.key === 'missing') throw new Error(`"${p.key}" cannot be used as a texture variable`);
      const java = {
        namespace: p.namespace ?? texture.java?.namespace ?? 'minecraft',
        folder: (p.folder ?? texture.java?.folder ?? 'block').replace(/^\/+|\/+$/g, ''),
        key: p.key ?? texture.java?.key ?? '0',
      };
      updateDocState(ctx, (s) => ({ ...s, textures: { ...s.textures, [id]: { ...s.textures[id], java, ...(p.name ? { name: p.name } : {}) } } }));
      const updated = docState(ctx).textures[id];
      return { id, name: updated.name, ...updated.java, location: textureLocation(updated) };
    },
  }),

  defineCommand({
    id: 'minecraft.set_group_pivot',
    title: 'Gruppen-Drehpunkt setzen',
    description: 'Set the pivot of a group in a Minecraft Java model, in model-space pixels (written into "groups" on export; default [8, 8, 8]).',
    params: z.object({ group: z.string().describe('Group id or name.'), pivot: pxVec3 }),
    run(ctx, p) {
      const id = resolveGroupId(docState(ctx), p.group);
      updateDocState(ctx, (s) => ({ ...s, groups: { ...s.groups, [id]: { ...s.groups[id], pivot: p.pivot } } }));
      return { id, pivot: p.pivot };
    },
  }),

  defineCommand({
    id: 'minecraft.validate',
    title: 'Modell prüfen',
    description:
      'Check a Minecraft Java model for problems the game would reject or show wrongly: texture names, namespaces and folders outside [a-z0-9._/-], elements outside the allowed coordinate range (-16..32 px), rotations the target version cannot express, faces with a UV of zero width or height, faces without a texture, and elements under a generated parent. Returns { valid (no errors), issues: [{ severity, code, message, objectId?, textureId? }] }.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const issues = validateJavaModel(docState(ctx));
      return { valid: !issues.some((i) => i.severity === 'error'), issues };
    },
  }),

  defineCommand({
    id: 'minecraft.export_json',
    title: 'Modell-JSON erzeugen',
    description:
      'Return the Minecraft Java model JSON of the document as text (what file_export writes to a .json file), for the target version of the document. selectionOnly: only the selected elements. Also returns fileName and the validation issues.',
    params: z.object({ selectionOnly: z.boolean().default(false) }),
    history: false,
    run(ctx, p) {
      const state = docState(ctx);
      const java = requireJava(state);
      return { fileName: `${java.fileName}.json`, text: exportJavaModel(state, p.selectionOnly ? { ids: state.selection } : {}), issues: validateJavaModel(state) };
    },
  }),

  defineCommand({
    id: 'document.import_java',
    title: 'Minecraft-Java-Modell öffnen',
    description:
      'Open a Minecraft Java block/item model (.json text) as a NEW Minecraft Java document tab. Usually you want the file_open tool instead, which reads a .json file from disk together with its textures from the resource pack. images: texture PNGs by the resource location the model uses (e.g. "block/stone" or "mymod:item/gear"); textures not given are looked up in the resource pack of sourcePath, the active project and the vanilla assets, else get a placeholder. Unknown root keys and "display" are kept and written back on export. parent: what to do with the parent model chain (looked up the same way): "show" (default) shows its elements and textures read-only (generated items as their flat extruded layers), "merge" turns them into elements and textures of the model itself, "reference" only keeps the "parent" text. Returns { id, name, active, warnings, parent }.',
    params: z.object({
      json: z.string().min(1),
      name: z.string().min(1).default('model'),
      fileName: z.string().min(1).optional().describe('Model file name without .json; default: name.'),
      version: z.string().optional(),
      images: z
        .record(z.string(), z.object({ data: z.string().min(1), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }))
        .optional(),
      sourcePath: z.string().optional().describe('The file the model was read from, for finding its parent models and textures.'),
      parent: z.enum(parentModes).default('show'),
      activate: z.boolean().default(true),
    }),
    async run(ctx, p) {
      const source = ctx.services.modelFiles?.source(p.sourcePath ?? null) ?? null;
      const opened = await openJavaModelWithParents(p.json, { version: p.version, fileName: p.fileName ?? p.name, images: p.images, sourcePath: p.sourcePath, parent: p.parent }, source);
      const { state, warnings } = opened;
      const names = Object.values(ctx.get().docs).map((d) => d.name);
      const doc = createDoc(uniqueName(names, p.name), state);
      ctx.set((app) => {
        const next = addDoc(app, doc);
        return p.activate ? next : { ...next, activeDocId: app.activeDocId };
      });
      return { id: doc.id, name: doc.name, active: p.activate, format: 'minecraft_java', elements: state.order.length, warnings, parent: opened.parent, ...(opened.merged ? { merged: opened.merged } : {}) };
    },
  }),
];

export { MISSING_TEXTURE_PNG };
