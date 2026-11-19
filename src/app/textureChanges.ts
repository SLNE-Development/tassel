// The "texture changed" hook: tells interested code (e.g. a texture library that saves linked textures back
// to their PNG files) when a document texture's image or layers were replaced, whatever did it: a paint
// command from the UI or MCP, undo, redo, a transform, an import. Textures are immutable, so a changed
// texture is a new object; this compares the documents' texture maps after every store update.
import type { AppState, Texture } from '../core/types';
import { useApp } from './store';

export interface TextureChange {
  readonly docId: string;
  readonly textureId: string;
  /** The texture before (undefined: it was added). */
  readonly before: Texture | undefined;
  /** The texture now (undefined: it was removed). */
  readonly after: Texture | undefined;
  /** True if the pixels changed (image data, layers, size or animation), false for metadata (name, location) only. */
  readonly pixels: boolean;
}

type Listener = (changes: readonly TextureChange[]) => void;

const listeners = new Set<Listener>();
let unsubscribe: (() => void) | null = null;

const pixelsDiffer = (a: Texture | undefined, b: Texture | undefined): boolean =>
  !a || !b || a.data !== b.data || a.layers !== b.layers || a.width !== b.width || a.height !== b.height || a.animation !== b.animation;

/** The texture changes from one app state to the next, in documents that exist in both (opening or closing a tab is no change). */
export function textureChanges(previous: Pick<AppState, 'docs'>, next: Pick<AppState, 'docs'>): TextureChange[] {
  const changes: TextureChange[] = [];
  if (previous.docs === next.docs) return changes;
  for (const [docId, doc] of Object.entries(next.docs)) {
    const old = Object.hasOwn(previous.docs, docId) ? previous.docs[docId] : undefined;
    if (!old || old.state.textures === doc.state.textures) continue;
    const before = old.state.textures;
    const after = doc.state.textures;
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const a = Object.hasOwn(before, id) ? before[id] : undefined;
      const b = Object.hasOwn(after, id) ? after[id] : undefined;
      if (a !== b) changes.push({ docId, textureId: id, before: a, after: b, pixels: pixelsDiffer(a, b) });
    }
  }
  return changes;
}

/**
 * Calls `listener` after every store update that replaced, added or removed document textures (paint
 * commands, undo / redo, transforms ...). Returns the function that stops it.
 */
export function onTextureChanged(listener: Listener): () => void {
  listeners.add(listener);
  unsubscribe ??= useApp.subscribe((next, previous) => {
    const changes = textureChanges(previous, next);
    if (changes.length > 0) for (const l of [...listeners]) l(changes);
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
