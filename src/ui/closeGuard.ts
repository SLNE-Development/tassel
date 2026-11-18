import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useApp } from '../app/store';
import { notifyError } from './toast';
import { useUi } from './uiStore';

export function dirtyDocNames(): string[] {
  const app = useApp.getState();
  return app.docOrder.map((id) => app.docs[id]).filter((d) => d.dirty).map((d) => d.name);
}

/** Asks before the window closes while any document has unsaved changes. */
export function installCloseGuard(): void {
  if (isTauri()) {
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (dirtyDocNames().length > 0) {
          event.preventDefault();
          useUi.setState({ quitOpen: true });
        }
      })
      .catch(notifyError);
  } else {
    window.addEventListener('beforeunload', (event) => {
      if (dirtyDocNames().length > 0) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  }
}

/** Closes the window without asking again. */
export function quitNow(): void {
  getCurrentWindow().destroy().catch(notifyError);
}
