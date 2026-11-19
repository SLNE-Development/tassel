// Document formats: what kind of model a document is, and which commands work in which kind.
// A 'free' document is a general 3D model (polygon meshes, modifiers, materials, animation); a
// 'minecraft_java' document is a Minecraft Java block/item model built from cuboid elements; a 'minecraft_factory'
// document is a Minecraft Java model too (everything that works there works here) plus a machine definition with
// ports for a server plugin (core/minecraft/factory).
import type { DocFormat, DocState } from './types';

export { docFormats, type DocFormat } from './types';

export function docFormat(state: Pick<DocState, 'format'>): DocFormat {
  return state.format ?? 'free';
}

/** Whether the document is a Minecraft Java model: a plain one or a factory model, which extends it. */
export const isMinecraft = (state: Pick<DocState, 'format'>): boolean => isMinecraftFormat(docFormat(state));
export const isMinecraftFormat = (format: DocFormat): boolean => format === 'minecraft_java' || format === 'minecraft_factory';
export const isFactory = (state: Pick<DocState, 'format'>): boolean => docFormat(state) === 'minecraft_factory';

/** English name of a format, for error messages and MCP descriptions. */
export const formatNames: Record<DocFormat, string> = {
  free: 'Free model',
  minecraft_java: 'Minecraft Java Block/Item',
  minecraft_factory: 'Minecraft Factory Model',
};

export const FREE_ONLY: readonly DocFormat[] = ['free'];
export const MINECRAFT_ONLY: readonly DocFormat[] = ['minecraft_java', 'minecraft_factory'];
export const FACTORY_ONLY: readonly DocFormat[] = ['minecraft_factory'];

/**
 * Formats of the commands that do not declare `formats` themselves, by id prefix or full id. Commands of
 * a prefix that is not listed work in every format. Keeping the list here (rather than on every
 * definition) makes the split between the formats reviewable in one place.
 */
const formatsByCommand: Readonly<Record<string, readonly DocFormat[]>> = {
  // Polygon modeling: edit mode, mesh operations, UV unwrapping, modifiers.
  'edit.': FREE_ONLY,
  'mesh.': FREE_ONLY,
  'uv.': FREE_ONLY,
  'modifier.': FREE_ONLY,
  // PBR materials, texture painting, baking, keyframe animation and video.
  'material.': FREE_ONLY,
  'paint.': FREE_ONLY,
  'bake.': FREE_ONLY,
  'anim.': FREE_ONLY,
  'render.video': FREE_ONLY,
  'texture.normal_from_height': FREE_ONLY,
  // Free-form objects: primitives, text, tubes, raw meshes, booleans, smoothing, baking transforms.
  'scene.add_primitive': FREE_ONLY,
  'scene.add_text': FREE_ONLY,
  'scene.add_tube': FREE_ONLY,
  'scene.add_mesh': FREE_ONLY,
  'scene.boolean': FREE_ONLY,
  'scene.set_smooth': FREE_ONLY,
  'scene.apply_transform': FREE_ONLY,
  'scene.mirror_objects': FREE_ONLY,
  // Minecraft cuboid elements and model settings.
  'cuboid.': MINECRAFT_ONLY,
  'minecraft.': MINECRAFT_ONLY,
  // Factory machine definition: ports, footprint, facings.
  'factory.': FACTORY_ONLY,
};

/** The formats a command works in; undefined = every format. `declared` is the command's own `formats`. */
export function commandFormats(id: string, declared?: readonly DocFormat[]): readonly DocFormat[] | undefined {
  if (declared) return declared;
  if (Object.hasOwn(formatsByCommand, id)) return formatsByCommand[id];
  const prefix = id.slice(0, id.indexOf('.') + 1);
  return prefix && Object.hasOwn(formatsByCommand, prefix) ? formatsByCommand[prefix] : undefined;
}

export function commandAllowedIn(id: string, declared: readonly DocFormat[] | undefined, format: DocFormat): boolean {
  const formats = commandFormats(id, declared);
  return !formats || formats.includes(format);
}

/** The sentence MCP descriptions start with for commands that only work in some formats, or ''. */
export function formatNote(id: string, declared?: readonly DocFormat[]): string {
  const formats = commandFormats(id, declared);
  if (!formats) return '';
  return `Only in ${formats.map((f) => formatNames[f]).join(' or ')} documents (see document_list "format"). `;
}

export function formatError(id: string, declared: readonly DocFormat[] | undefined, format: DocFormat, docName: string): Error {
  const formats = commandFormats(id, declared) ?? [];
  return new Error(
    `${id} is not available in ${formatNames[format]} documents: it only works in ${formats.map((f) => formatNames[f]).join(' or ')} documents, and "${docName}" is a ${formatNames[format]} document.`,
  );
}
