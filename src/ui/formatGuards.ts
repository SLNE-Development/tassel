import { useEffect } from 'react';
import { execute, selectDocState, useApp } from '../app/store';
import { isMinecraft } from '../core/formats';
import type { AppState, Tool, Workspace } from '../core/types';
import { notifyError } from './toast';

/** What the app-wide tool and workspace have to become for the active document, or null if they fit. */
export function fallbackFor(app: Pick<AppState, 'tool' | 'workspace'>, minecraft: boolean): { tool?: Tool; workspace?: Workspace } | null {
  // Only Minecraft documents have the display workspace.
  if (!minecraft) return app.workspace === 'display' ? { workspace: 'modeling' } : null;
  const fix: { tool?: Tool; workspace?: Workspace } = {};
  // Elements are resized in the element panel; there is no scale tool, and no painting of meshes.
  if (app.tool === 'scale') fix.tool = 'move';
  if (app.workspace === 'paint') fix.workspace = 'modeling';
  return fix.tool || fix.workspace ? fix : null;
}

/**
 * The tool and the workspace belong to the app, not to a document: switching to a Minecraft document
 * while the scale tool or the paint workspace is active moves them to what the document has.
 */
export function useFormatGuards(): void {
  useEffect(() => {
    const check = () => {
      const app = useApp.getState();
      const fix = fallbackFor(app, isMinecraft(selectDocState(app)));
      if (!fix) return;
      if (fix.tool) execute('view.set_tool', { tool: fix.tool }).catch(notifyError);
      if (fix.workspace) execute('app.set_workspace', { workspace: fix.workspace }).catch(notifyError);
    };
    check();
    return useApp.subscribe(check);
  }, []);
}
