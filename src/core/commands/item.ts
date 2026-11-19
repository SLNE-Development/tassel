// Commands of Minecraft item model definition documents ('minecraft_item' format; core/minecraft/items).
import { z } from 'zod';
import { formatResourceLocation, parseResourceLocation } from '../minecraftAssets';
import { itemDefinitionToJson, nodeToJson, parseItemDefinitionText, parseNode, serializeItemDefinition } from '../minecraft/items/codec';
import { itemDocState, itemFilePath, itemIdProblem, itemLocationFromPath, modelLocationFromPath, newItemSettings } from '../minecraft/items/document';
import { evaluateItem } from '../minecraft/items/evaluate';
import { DISPLAY_CONTEXTS, itemSpecs, normalizeId, shortId } from '../minecraft/items/registry';
import { singleModelDefinition, variantModes, variantsNode } from '../minecraft/items/templates';
import {
  changeType,
  createSpecial,
  createTint,
  firstModelRef,
  getNode,
  insertAt,
  joinPath,
  modelRef,
  moveItem,
  nextCaseValue,
  nextThreshold,
  patchFields,
  removeAt,
  setProperty,
  updateNode,
  walk,
} from '../minecraft/items/tree';
import type { ItemDefinition, ItemDocSettings, ItemModelNode, Json } from '../minecraft/items/types';
import { validateItemDefinition } from '../minecraft/items/validate';
import { DEFAULT_VERSION, isJavaVersion, javaVersions } from '../minecraft/versions';
import { addDoc, createDoc, uniqueName } from '../state';
import type { DocState } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

const json = z.unknown().transform((v) => v as Json);
const jsonObject = z.record(z.string(), z.unknown()).transform((v) => v as Record<string, Json>);

const pathParam = z
  .string()
  .default('')
  .describe('Node path: "" is the root model; steps are fallback, on_true, on_false, cases/N, entries/N, models/N joined by "/", e.g. "cases/0/on_true". item_get lists every node with its path.');

const versionParam = z.string().optional().describe(`Target Minecraft Java version, one of ${javaVersions.map((v) => v.id).join(', ')}. Default: the newest.`);

function requireItem(state: DocState): ItemDocSettings {
  if (!state.item) throw new Error('The document is not a Minecraft item definition');
  return state.item;
}

function updateItem(ctx: CommandContext, update: (item: ItemDocSettings) => ItemDocSettings): ItemDocSettings {
  let result: ItemDocSettings | null = null;
  updateDocState(ctx, (state) => {
    result = update(requireItem(state));
    return { ...state, item: result };
  });
  return result!;
}

function updateDefinition(ctx: CommandContext, update: (def: ItemDefinition, version: string) => ItemDefinition): ItemDefinition {
  return updateItem(ctx, (item) => ({ ...item, definition: update(item.definition, item.version) })).definition;
}

function nodeFromJson(raw: Json, what: string): ItemModelNode {
  const node = parseNode(raw);
  if (!node) throw new Error(`${what} must be an item model object with a "type", e.g. {"type": "minecraft:model", "model": "minecraft:item/stick"}`);
  return node;
}

function checkVersion(version: string | undefined): string {
  const v = version ?? DEFAULT_VERSION;
  if (!isJavaVersion(v)) throw new Error(`Unknown Minecraft Java version "${v}". Known: ${javaVersions.map((x) => x.id).join(', ')}`);
  return v;
}

function checkLocation(namespace: string, id: string): void {
  const problem = itemIdProblem(namespace, id);
  if (problem) throw new Error(problem);
}

/** One line per node, for item_get. */
function summary(node: ItemModelNode): string {
  switch (node.kind) {
    case 'model':
      return `model ${node.model || '(none)'}${node.tints?.length ? `, ${node.tints.length} tint(s)` : ''}`;
    case 'composite':
      return `composite of ${node.models.length}`;
    case 'condition':
      return `condition ${shortId(node.property)}`;
    case 'select':
      return `select ${shortId(node.property)}: ${node.cases.length} case(s)${node.fallback ? ' + fallback' : ''}`;
    case 'range_dispatch':
      return `range_dispatch ${shortId(node.property)}: ${node.entries.length} entr${node.entries.length === 1 ? 'y' : 'ies'}${node.fallback ? ' + fallback' : ''}`;
    case 'special':
      return `special ${shortId(node.special.type)} (base ${node.base})`;
    default:
      return shortId(node.type);
  }
}

function describeItem(item: ItemDocSettings) {
  return {
    namespace: item.namespace,
    id: item.id,
    version: item.version,
    file: itemFilePath(item),
    nodes: walk(item.definition).map(({ path, node, depth }) => ({ path, depth, type: node.type, summary: summary(node) })),
    json: itemDefinitionToJson(item.definition),
  };
}

/** Opens an item definition as a new document tab. */
function openItemDoc(ctx: CommandContext, item: ItemDocSettings, name: string, activate: boolean, filePath: string | null = null) {
  const doc = createDoc(uniqueName(Object.values(ctx.get().docs).map((d) => d.name), name), itemDocState(item), filePath);
  ctx.set((app) => {
    const next = addDoc(app, doc);
    return activate ? next : { ...next, activeDocId: app.activeDocId };
  });
  return { id: doc.id, name: doc.name, active: activate, format: 'minecraft_item' as const, file: itemFilePath(item) };
}

/** Opens item definition text as a new document; namespace and id come from the path when it is in a pack. */
export function importItemDefinition(
  ctx: CommandContext,
  p: { json: string; namespace?: string; itemId?: string; filePath?: string; name?: string; version?: string; activate: boolean },
) {
  const version = checkVersion(p.version);
  const definition = parseItemDefinitionText(p.json);
  const fromPath = p.filePath ? itemLocationFromPath(p.filePath) : null;
  const fileStem = p.filePath?.split(/[\/]/).pop()?.replace(/\.json$/i, '');
  const namespace = p.namespace ?? fromPath?.namespace ?? 'minecraft';
  const id = p.itemId ?? fromPath?.id ?? fileStem ?? 'item';
  checkLocation(namespace, id);
  const item = newItemSettings(definition, { namespace, id, version });
  const issues = validateItemDefinition(definition, version);
  return { ...openItemDoc(ctx, item, p.name ?? id.split('/').pop()!, p.activate, p.filePath ?? null), issues: issues.length, warnings: [] as string[] };
}

const variantsParam = z.object({
  base: z.string().min(1).describe('Model shown when no variant applies, e.g. "minecraft:item/diamond_sword".'),
  mode: z
    .enum(variantModes)
    .default('range')
    .describe(
      'How variants are chosen from the custom_model_data component: "range" by a number in floats (range_dispatch; like the old integer CustomModelData), "select" by a string in strings, "flags" by a boolean in flags (one condition per variant).',
    ),
  index: z.number().int().min(0).default(0).describe('Position in the floats / strings / flags list (index field). Flags use index + variant position.'),
  variants: z
    .array(z.object({ model: z.string().min(1), value: z.union([z.number(), z.string()]).optional().describe('range: the number (threshold); select: the string. Default: 1, 2, 3 ... / variant_1 ...') }))
    .min(1),
});

export const itemCommands = [
  defineCommand({
    id: 'document.new_item',
    title: 'Neue Item-Definition',
    description:
      'Create a new Minecraft Java item model definition (assets/<namespace>/items/<id>.json, Minecraft 1.21.4+ / 26.x) as a new document tab of format "minecraft_item". In such a document only the item_* tools (plus document, history, view and preferences tools) work. Start it with one model (model), or with a base model plus custom_model_data variants (variants), or empty (a minecraft:model without a reference). Returns { id, name, active, format, file }.',
    params: z.object({
      namespace: z.string().default('minecraft').describe('Namespace of the item, e.g. "minecraft" to change a vanilla item or "mymod".'),
      itemId: z.string().min(1).describe('Item id without namespace and .json, e.g. "diamond_sword".'),
      name: z.string().min(1).optional().describe('Tab name; default: the item id.'),
      version: versionParam,
      model: z.string().optional().describe('Model reference the item shows, e.g. "minecraft:item/diamond_sword" or "mymod:item/ruby_sword".'),
      variants: variantsParam.optional().describe('Base model with custom_model_data variants instead of a single model.'),
      activate: z.boolean().default(true),
    }),
    run(ctx, p) {
      const version = checkVersion(p.version);
      checkLocation(p.namespace, p.itemId);
      const definition = p.variants
        ? { model: variantsNode(p.variants.base, p.variants.variants, p.variants.mode, p.variants.index), fields: {} }
        : singleModelDefinition(p.model ?? '');
      return openItemDoc(ctx, newItemSettings(definition, { namespace: p.namespace, id: p.itemId, version }), p.name ?? p.itemId, p.activate);
    },
  }),

  defineCommand({
    id: 'document.import_item',
    title: 'Item-Definition öffnen',
    description:
      'Open item model definition JSON text (the content of an assets/<namespace>/items/<id>.json file) as a new "minecraft_item" document. Usually you want file_open instead, which reads the file from disk. Everything in the file is kept, also keys and types Tessel does not know, and written back in the same key order. filePath (if given) supplies namespace and id when it contains assets/<namespace>/items/<id>.json.',
    params: z.object({
      json: z.string().min(1),
      namespace: z.string().optional(),
      itemId: z.string().optional(),
      filePath: z.string().optional().describe('Where the file is; saving writes back to it.'),
      name: z.string().min(1).optional(),
      version: versionParam,
      activate: z.boolean().default(true),
    }),
    run(ctx, p) {
      return importItemDefinition(ctx, p);
    },
  }),

  defineCommand({
    id: 'minecraft.create_item_definition',
    title: 'Item-Definition für dieses Modell erstellen',
    description:
      'From the active Minecraft Java model document: create a new item definition document that shows this model (assets/<namespace>/items/<id>.json with a minecraft:model node). model defaults to the model\'s resource location when the document was opened from assets/<ns>/models/..., else "<namespace>:item/<fileName>". Optionally as the base of custom_model_data variants.',
    params: z.object({
      model: z.string().optional().describe('Model reference; default: derived from the document (see description).'),
      namespace: z.string().optional().describe('Item namespace; default: the model\'s namespace.'),
      itemId: z.string().optional().describe('Item id; default: the model file name.'),
      variants: variantsParam.omit({ base: true }).optional().describe('Make this model the base of custom_model_data variants.'),
      activate: z.boolean().default(true),
    }),
    run(ctx, p) {
      const state = docState(ctx);
      const java = state.java!;
      const doc = ctx.get().docs[ctx.get().activeDocId];
      const fromPath = doc.filePath ? modelLocationFromPath(doc.filePath) : null;
      const namespaces = Object.values(state.textures)
        .map((t) => t.java?.namespace)
        .filter((n): n is string => !!n && n !== 'minecraft');
      const fallbackNamespace = namespaces[0] ?? 'minecraft';
      const model = p.model ?? fromPath ?? `${fallbackNamespace}:item/${java.fileName}`;
      const location = parseResourceLocation(model);
      const namespace = p.namespace ?? location.namespace;
      const id = p.itemId ?? java.fileName;
      checkLocation(namespace, id);
      const ref = formatResourceLocation(location);
      const definition = p.variants ? { model: variantsNode(ref, p.variants.variants, p.variants.mode, p.variants.index), fields: {} } : singleModelDefinition(ref);
      return openItemDoc(ctx, newItemSettings(definition, { namespace, id, version: java.version }), id, p.activate);
    },
  }),

  defineCommand({
    id: 'item.get',
    title: 'Item-Definition lesen',
    description:
      'Get the item definition of the document: namespace, id, version, file (its path in a resource pack), nodes (every node with its path, depth, type and a one-line summary; use the paths with the other item_* tools) and json (the definition as it will be written).',
    params: z.object({}),
    history: false,
    run(ctx) {
      return describeItem(requireItem(docState(ctx)));
    },
  }),

  defineCommand({
    id: 'item.get_options',
    title: 'Item-Optionen auflisten',
    description:
      'List what the document\'s target version accepts: model types, properties for condition / select / range_dispatch with their fields (key, kind, required, default, options), select value formats, tint sources and special model types. Use it to find valid values before editing.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const specs = itemSpecs(requireItem(docState(ctx)).version);
      return { ...specs, displayContexts: DISPLAY_CONTEXTS };
    },
  }),

  defineCommand({
    id: 'item.export_json',
    title: 'Item-Definition als JSON',
    description: 'Return the item definition file text (two-space indented JSON) with its file name and its path in a resource pack. file_save writes it to disk.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const item = requireItem(docState(ctx));
      return { text: serializeItemDefinition(item.definition), fileName: `${item.id.split('/').pop()}.json`, path: itemFilePath(item) };
    },
  }),

  defineCommand({
    id: 'item.validate',
    title: 'Item-Definition prüfen',
    description: 'Check the item definition against its target version: unknown types / properties / fields, missing or invalid values, select cases Minecraft never matches, missing fallbacks. Returns { valid, issues: [{ severity, code, path, subject, message }] }.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const item = requireItem(docState(ctx));
      const issues = validateItemDefinition(item.definition, item.version);
      return { valid: !issues.some((i) => i.severity === 'error'), issues };
    },
  }),

  defineCommand({
    id: 'item.evaluate',
    title: 'Item-Definition auswerten',
    description:
      'Which model(s) the item renders in a given situation (the preview\'s test inputs): follows conditions, selects and range dispatches like the game. Returns { rendered: [{ path, kind, model, tints, special, transformations }], decisions: [{ path, property, value, picked }] }; kind "unknown" with model "" means the missing model.',
    params: z.object({
      displayContext: z.enum(DISPLAY_CONTEXTS).default('gui'),
      customModelData: z
        .object({ floats: z.array(z.number()).optional(), flags: z.array(z.boolean()).optional(), strings: z.array(z.string()).optional(), colors: z.array(z.number()).optional() })
        .optional(),
      damage: z.number().optional(),
      maxDamage: z.number().optional(),
      count: z.number().optional(),
      maxStackSize: z.number().optional(),
      conditions: z.record(z.string(), z.boolean()).optional().describe('Other boolean properties by full id, e.g. {"minecraft:using_item": true}; keybind_down as "minecraft:keybind_down/key.use".'),
      selects: z.record(z.string(), z.unknown()).optional().describe('Other select properties by full id, e.g. {"minecraft:main_hand": "left"}.'),
      numbers: z.record(z.string(), z.number()).optional().describe('Other numeric properties by full id, e.g. {"minecraft:use_duration": 20}.'),
    }),
    history: false,
    run(ctx, p) {
      return evaluateItem(requireItem(docState(ctx)).definition, { ...p, selects: p.selects as Record<string, Json> | undefined });
    },
  }),

  defineCommand({
    id: 'item.set_settings',
    title: 'Item-Einstellungen',
    description:
      'Change the item\'s namespace, id, target version and the root options of the file: handAnimationOnSwap (hand_animation_on_swap, default true), oversizedInGui (oversized_in_gui, default false), swapAnimationScale (swap_animation_scale, default 1). null removes a root option (Minecraft then uses its default).',
    params: z.object({
      namespace: z.string().optional(),
      itemId: z.string().optional(),
      version: z.string().optional(),
      handAnimationOnSwap: z.boolean().nullable().optional(),
      oversizedInGui: z.boolean().nullable().optional(),
      swapAnimationScale: z.number().finite().nullable().optional(),
    }),
    run(ctx, p) {
      const item = updateItem(ctx, (item) => {
        const namespace = p.namespace ?? item.namespace;
        const id = p.itemId ?? item.id;
        checkLocation(namespace, id);
        const version = p.version === undefined ? item.version : checkVersion(p.version);
        const patch: Record<string, Json> = {};
        if (p.handAnimationOnSwap !== undefined) patch.hand_animation_on_swap = p.handAnimationOnSwap;
        if (p.oversizedInGui !== undefined) patch.oversized_in_gui = p.oversizedInGui;
        if (p.swapAnimationScale !== undefined) patch.swap_animation_scale = p.swapAnimationScale;
        const fields = patchFields(item.definition.fields, patch);
        return { ...item, namespace, id, version, definition: { ...item.definition, fields } };
      });
      return { namespace: item.namespace, id: item.id, version: item.version, file: itemFilePath(item) };
    },
  }),

  defineCommand({
    id: 'item.set_node',
    title: 'Knoten ersetzen',
    description: 'Replace the node at path with an item model given as JSON (any type, with all its children), e.g. {"type": "minecraft:model", "model": "minecraft:item/stick"}. The most direct way to write a whole subtree.',
    params: z.object({ path: pathParam, json }),
    run(ctx, p) {
      const node = nodeFromJson(p.json, 'json');
      updateDefinition(ctx, (def) => updateNode(def, p.path, () => node));
      return { path: p.path, type: node.type };
    },
  }),

  defineCommand({
    id: 'item.set_type',
    title: 'Knotentyp ändern',
    description:
      'Change the type of the node at path (e.g. "minecraft:select"). Turning a node into a container keeps the old node inside it (as fallback of a select or range_dispatch, as both branches of a condition, as the first part of a composite), so this also works as "wrap in". New conditions, selects and range dispatches start with the custom_model_data property.',
    params: z.object({ path: pathParam, type: z.string().min(1) }),
    run(ctx, p) {
      const def = updateDefinition(ctx, (def, version) => updateNode(def, p.path, (node) => changeType(node, p.type, version)));
      return { path: p.path, type: getNode(def, p.path).type };
    },
  }),

  defineCommand({
    id: 'item.update_node',
    title: 'Knoten bearbeiten',
    description:
      'Change parts of the node at path. model: model reference (minecraft:model). base and specialType / specialFields: base model and special model (minecraft:special; specialType starts the options afresh). property: property of a condition / select / range_dispatch (drops the old property\'s options, adds the new one\'s required options). fields: options of the node\'s property (e.g. {"index": 1}, {"normalize": false}); null removes a key. scale: range_dispatch scale (null removes). transformation: matrix or {translation, left_rotation, scale, right_rotation} (null removes).',
    params: z.object({
      path: pathParam,
      model: z.string().optional(),
      base: z.string().optional(),
      property: z.string().optional(),
      fields: jsonObject.optional(),
      scale: z.number().finite().nullable().optional(),
      specialType: z.string().optional(),
      specialFields: jsonObject.optional(),
      transformation: json.optional(),
    }),
    run(ctx, p) {
      const def = updateDefinition(ctx, (def, version) =>
        updateNode(def, p.path, (current) => {
          let node = current;
          if (p.property !== undefined) node = setProperty(node, p.property, version);
          if (p.fields) node = { ...node, fields: patchFields(node.fields, p.fields) };
          if (p.model !== undefined) {
            if (node.kind !== 'model') throw new Error(`"model" only applies to minecraft:model nodes; the node at "${p.path}" is ${node.type}`);
            node = { ...node, model: p.model.trim() };
          }
          if (p.scale !== undefined) {
            if (node.kind !== 'range_dispatch') throw new Error(`"scale" only applies to range_dispatch nodes; the node at "${p.path}" is ${node.type}`);
            const { scale: _old, ...rest } = node;
            node = p.scale === null ? rest : { ...rest, scale: p.scale };
          }
          if (p.base !== undefined || p.specialType !== undefined || p.specialFields !== undefined) {
            if (node.kind !== 'special') throw new Error(`"base", "specialType" and "specialFields" only apply to special nodes; the node at "${p.path}" is ${node.type}`);
            let special = p.specialType !== undefined && normalizeId(p.specialType) !== normalizeId(node.special.type) ? createSpecial(p.specialType, version) : node.special;
            if (p.specialFields) special = { ...special, fields: patchFields(special.fields, p.specialFields) };
            node = { ...node, special, base: p.base?.trim() ?? node.base };
          }
          if (p.transformation !== undefined) {
            const { transformation: _old, ...rest } = node;
            node = p.transformation === null ? (rest as ItemModelNode) : ({ ...rest, transformation: p.transformation } as ItemModelNode);
          }
          return node;
        }),
      );
      return { path: p.path, node: nodeToJson(getNode(def, p.path)) };
    },
  }),

  defineCommand({
    id: 'item.add_child',
    title: 'Fall hinzufügen',
    description:
      'Add a part to the node at path: a case to a select (when), an entry to a range_dispatch (threshold) or a model to a composite. json is the new part\'s item model (default: a minecraft:model with the first model reference found in the node). when / threshold default to an unused value. index: position (default: the end). Returns the new part\'s path.',
    params: z.object({
      path: pathParam,
      index: z.number().int().min(0).optional(),
      when: json.optional().describe('select: a value or a list of values.'),
      threshold: z.number().finite().optional(),
      json: json.optional(),
    }),
    run(ctx, p) {
      let added = '';
      updateDefinition(ctx, (def, version) =>
        updateNode(def, p.path, (node) => {
          const model = p.json !== undefined ? nodeFromJson(p.json, 'json') : modelRef(firstModelRef(node));
          if (node.kind === 'select') {
            const cases = insertAt(node.cases, { when: p.when ?? nextCaseValue(node, version), model, fields: {} }, p.index);
            added = joinPath(p.path, 'cases', Math.min(p.index ?? cases.length - 1, cases.length - 1));
            return { ...node, cases };
          }
          if (node.kind === 'range_dispatch') {
            const entries = insertAt(node.entries, { threshold: p.threshold ?? nextThreshold(node), model, fields: {} }, p.index);
            added = joinPath(p.path, 'entries', Math.min(p.index ?? entries.length - 1, entries.length - 1));
            return { ...node, entries };
          }
          if (node.kind === 'composite') {
            const models = insertAt(node.models, model, p.index);
            added = joinPath(p.path, 'models', Math.min(p.index ?? models.length - 1, models.length - 1));
            return { ...node, models };
          }
          throw new Error(`Only select, range_dispatch and composite nodes have a list of parts; the node at "${p.path}" is ${node.type}`);
        }),
      );
      return { path: added };
    },
  }),

  defineCommand({
    id: 'item.remove_child',
    title: 'Fall entfernen',
    description: 'Remove part `index` (a case, an entry or a composite model) from the node at path.',
    params: z.object({ path: pathParam, index: z.number().int().min(0) }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind === 'select') return { ...node, cases: removeAt(node.cases, p.index) };
          if (node.kind === 'range_dispatch') return { ...node, entries: removeAt(node.entries, p.index) };
          if (node.kind === 'composite') return { ...node, models: removeAt(node.models, p.index) };
          throw new Error(`The node at "${p.path}" (${node.type}) has no list of parts`);
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.move_child',
    title: 'Fall verschieben',
    description: 'Move part `from` of the node at path to position `to` (cases are matched in order, so this changes which case wins).',
    params: z.object({ path: pathParam, from: z.number().int().min(0), to: z.number().int().min(0) }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind === 'select') return { ...node, cases: moveItem(node.cases, p.from, p.to) };
          if (node.kind === 'range_dispatch') return { ...node, entries: moveItem(node.entries, p.from, p.to) };
          if (node.kind === 'composite') return { ...node, models: moveItem(node.models, p.from, p.to) };
          throw new Error(`The node at "${p.path}" (${node.type}) has no list of parts`);
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.update_child',
    title: 'Fall bearbeiten',
    description: 'Change the "when" of case `index` of a select, or the threshold of entry `index` of a range_dispatch, at path.',
    params: z.object({ path: pathParam, index: z.number().int().min(0), when: json.optional(), threshold: z.number().finite().optional() }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind === 'select') {
            if (!node.cases[p.index]) throw new Error(`The select at "${p.path}" has no case ${p.index}`);
            return { ...node, cases: node.cases.map((c, i) => (i === p.index && p.when !== undefined ? { ...c, when: p.when } : c)) };
          }
          if (node.kind === 'range_dispatch') {
            if (!node.entries[p.index]) throw new Error(`The range_dispatch at "${p.path}" has no entry ${p.index}`);
            return { ...node, entries: node.entries.map((e, i) => (i === p.index && p.threshold !== undefined ? { ...e, threshold: p.threshold } : e)) };
          }
          throw new Error(`The node at "${p.path}" (${node.type}) is neither a select nor a range_dispatch`);
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.set_fallback',
    title: 'Fallback setzen',
    description: 'Give the select or range_dispatch at path a fallback (json, default: a minecraft:model with its first model reference), or remove it (remove: true).',
    params: z.object({ path: pathParam, json: json.optional(), remove: z.boolean().default(false) }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind !== 'select' && node.kind !== 'range_dispatch') throw new Error(`Only select and range_dispatch nodes have a fallback; the node at "${p.path}" is ${node.type}`);
          if (p.remove) {
            const { fallback: _old, ...rest } = node;
            return rest as ItemModelNode;
          }
          return { ...node, fallback: p.json !== undefined ? nodeFromJson(p.json, 'json') : modelRef(firstModelRef(node)) };
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.add_tint',
    title: 'Tönung hinzufügen',
    description:
      'Add a tint source to the minecraft:model node at path (tint i colours the faces with tintindex i). type e.g. "minecraft:dye", "minecraft:constant", "minecraft:custom_model_data"; fields are its options (colours as int ARGB, e.g. -6265536, or [r, g, b] floats 0..1). Required options left out start with an example value.',
    params: z.object({ path: pathParam, type: z.string().min(1), fields: jsonObject.optional(), index: z.number().int().min(0).optional() }),
    run(ctx, p) {
      updateDefinition(ctx, (def, version) =>
        updateNode(def, p.path, (node) => {
          if (node.kind !== 'model') throw new Error(`Tints only exist on minecraft:model nodes; the node at "${p.path}" is ${node.type}`);
          const tint = createTint(p.type, version);
          const withFields = p.fields ? { ...tint, fields: patchFields(tint.fields, p.fields) } : tint;
          return { ...node, tints: insertAt(node.tints ?? [], withFields, p.index) };
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.update_tint',
    title: 'Tönung bearbeiten',
    description: 'Change tint `index` of the minecraft:model node at path: type (starts its options afresh) and/or fields (null removes a key).',
    params: z.object({ path: pathParam, index: z.number().int().min(0), type: z.string().optional(), fields: jsonObject.optional() }),
    run(ctx, p) {
      updateDefinition(ctx, (def, version) =>
        updateNode(def, p.path, (node) => {
          if (node.kind !== 'model' || !node.tints?.[p.index]) throw new Error(`The node at "${p.path}" has no tint ${p.index}`);
          return {
            ...node,
            tints: node.tints.map((t, i) => {
              if (i !== p.index) return t;
              const typed = p.type !== undefined && normalizeId(p.type) !== normalizeId(t.type) ? createTint(p.type, version) : t;
              return p.fields ? { ...typed, fields: patchFields(typed.fields, p.fields) } : typed;
            }),
          };
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.remove_tint',
    title: 'Tönung entfernen',
    description: 'Remove tint `index` of the minecraft:model node at path. Removing the last one removes the "tints" key.',
    params: z.object({ path: pathParam, index: z.number().int().min(0) }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind !== 'model' || !node.tints) throw new Error(`The node at "${p.path}" has no tints`);
          const tints = removeAt(node.tints, p.index);
          const { tints: _old, ...rest } = node;
          return tints.length > 0 ? { ...rest, tints } : rest;
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.move_tint',
    title: 'Tönung verschieben',
    description: 'Move tint `from` of the minecraft:model node at path to position `to` (the position is the tintindex it colours).',
    params: z.object({ path: pathParam, from: z.number().int().min(0), to: z.number().int().min(0) }),
    run(ctx, p) {
      updateDefinition(ctx, (def) =>
        updateNode(def, p.path, (node) => {
          if (node.kind !== 'model' || !node.tints) throw new Error(`The node at "${p.path}" has no tints`);
          return { ...node, tints: moveItem(node.tints, p.from, p.to) };
        }),
      );
    },
  }),

  defineCommand({
    id: 'item.apply_variants',
    title: 'Varianten erzeugen',
    description:
      'Replace the node at path (default: the whole definition) with a base model plus custom_model_data variants (the common "one item, several looks" setup). mode "range": floats[index] picks the variant whose value is the highest one <= the number (give each variant its number as value); "select": strings[index] equal to the variant\'s value; "flags": the first variant whose flags[index + position] is true.',
    params: variantsParam.extend({ path: pathParam }),
    run(ctx, p) {
      const node = variantsNode(p.base, p.variants, p.mode, p.index);
      updateDefinition(ctx, (def) => updateNode(def, p.path, () => node));
      return { path: p.path, json: nodeToJson(node) };
    },
  }),
];
