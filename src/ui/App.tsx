import { Toast } from '@base-ui/react/toast';
import { Tooltip } from '@base-ui/react/tooltip';
import { Centre } from './Centre';
import { CommandPalette } from './CommandPalette';
import { Dialogs } from './Dialogs';
import { Outliner } from './Outliner';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { toastManager } from './toast';
import { Toasts } from './Toasts';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { useShortcuts } from './useShortcuts';

/** The editor shell. It subscribes to nothing itself, so state changes only re-render the panels that care. */
export function App() {
  useShortcuts();
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Tooltip.Provider delay={450} closeDelay={0}>
        <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <TopBar />
          <div className="grid min-h-0 grid-cols-[44px_minmax(0,1fr)_272px]">
            <ToolRail />
            <Centre />
            <aside aria-label="Szene und Eigenschaften" className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(7rem,2fr)_minmax(0,3fr)] border-l border-line bg-panel">
              <Outliner />
              <Properties />
            </aside>
          </div>
          <StatusBar />
        </div>
        <CommandPalette />
        <Dialogs />
        <Toasts />
      </Tooltip.Provider>
    </Toast.Provider>
  );
}
