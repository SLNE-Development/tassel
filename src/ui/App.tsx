import { Toast } from '@base-ui/react/toast';
import { Tooltip } from '@base-ui/react/tooltip';
import { Centre } from './Centre';
import { BakeDialog } from './bake/BakeDialog';
import { RenderDialog } from './render/RenderDialog';
import { VideoDialog } from './timeline/VideoDialog';
import { CommandPalette } from './CommandPalette';
import { Dialogs } from './Dialogs';
import { NewDocDialog } from './minecraft/NewDocDialog';
import { ModelImportDialogs } from './modelImport/ModelImportDialogs';
import { Preferences } from './Preferences';
import { StatusBar } from './StatusBar';
import { toastManager } from './toast';
import { Toasts } from './Toasts';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { useFormatGuards } from './formatGuards';
import { ItemWizard } from './items/ItemWizard';
import { registerItemFileOpener } from './items/itemActions';
import { useEffect } from 'react';
import { useShortcuts } from './useShortcuts';
import { GitHubDialog } from './projects/GitHubDialog';
import { ProjectDialogs } from './projects/ProjectDialogs';
import { DockMenu, DockOverlay, DockSide } from './layout/Dock';
import { LayoutsDialog } from './layout/LayoutMenu';

/**
 * The editor shell: the tool rail, the left sidebar, the centre and the right sidebar. The sidebars
 * show the dockable panels (see `layout/`); the shell itself subscribes to nothing, so state changes
 * only re-render the panels that care, and the centre (with the 3D viewport) never remounts.
 */
export function App() {
  useShortcuts();
  useFormatGuards();
  // Item definitions in the project tree open in the item editor.
  useEffect(() => registerItemFileOpener(), []);
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Tooltip.Provider delay={450} closeDelay={0}>
        <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <TopBar />
          <div className="grid min-h-0 grid-cols-[44px_auto_minmax(0,1fr)_auto]">
            <ToolRail />
            <DockSide side="left" />
            <Centre />
            <DockSide side="right" />
          </div>
          <StatusBar />
        </div>
        <CommandPalette />
        <Dialogs />
        <NewDocDialog />
        <ModelImportDialogs />
        <ItemWizard />
        <Preferences />
        <BakeDialog />
        <RenderDialog />
        <VideoDialog />
        <GitHubDialog />
        <ProjectDialogs />
        <LayoutsDialog />
        <DockMenu />
        <DockOverlay />
        <Toasts />
      </Tooltip.Provider>
    </Toast.Provider>
  );
}
