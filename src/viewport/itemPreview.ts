// What the viewport shows for Minecraft item definition documents. Such documents have no scene of their
// own: the item editor (src/ui/items) resolves the models the definition picks for the current test inputs
// and publishes them here as a Minecraft model scene, which the viewport then draws instead of the document.
import type { DocState } from '../core/types';

const scenes = new Map<string, DocState>();
const listeners = new Set<() => void>();

/** The scene shown for an item definition document, or undefined while there is none. */
export function itemPreviewScene(docId: string): DocState | undefined {
  return scenes.get(docId);
}

/** Sets (or with null clears) the scene shown for an item definition document. */
export function setItemPreviewScene(docId: string, scene: DocState | null): void {
  if (scene) scenes.set(docId, scene);
  else scenes.delete(docId);
  for (const listener of listeners) listener();
}

export function onItemPreviewChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
