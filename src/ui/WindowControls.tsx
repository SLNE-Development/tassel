import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent } from 'react';
import { useT } from '../i18n';
import { notifyError } from './toast';

// The native title bar is switched off (tauri.conf.json: decorations false), so the top bar
// doubles as the title bar: empty space drags the window, and these are the window buttons.

const INTERACTIVE = 'button, a, input, select, textarea, [role="tab"], [role="menuitem"], [role="radio"]';

/** Mouse-down handler for the top bar: drag the window, double-click toggles maximize. */
export function dragWindow(event: MouseEvent<HTMLElement>): void {
  if (!isTauri() || event.button !== 0) return;
  if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
  const win = getCurrentWindow();
  (event.detail === 2 ? win.toggleMaximize() : win.startDragging()).catch(notifyError);
}

const buttonClass = 'flex h-full w-11.5 items-center justify-center text-dim outline-none hover:text-text focus-visible:bg-raised';

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const sync = () => win.isMaximized().then(setMaximized, notifyError);
    void sync();
    const unlisten = win.onResized(() => void sync());
    return () => {
      unlisten.then((off) => off(), notifyError);
    };
  }, []);

  if (!isTauri()) return null;
  const win = getCurrentWindow();

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button className={`${buttonClass} hover:bg-raised`} aria-label={t.topBar.minimize} onClick={() => win.minimize().catch(notifyError)}>
        <Minus size={15} strokeWidth={1.5} />
      </button>
      <button
        className={`${buttonClass} hover:bg-raised`}
        aria-label={maximized ? t.topBar.restore : t.topBar.maximize}
        onClick={() => win.toggleMaximize().catch(notifyError)}
      >
        {maximized ? <Copy size={12.5} strokeWidth={1.5} className="-scale-x-100" /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      {/* close() goes through the close guard, so unsaved changes still ask first. */}
      <button className={`${buttonClass} hover:bg-danger hover:text-white`} aria-label={t.common.close} onClick={() => win.close().catch(notifyError)}>
        <X size={15} strokeWidth={1.5} />
      </button>
    </div>
  );
}
