import { Toast } from '@base-ui/react/toast';
import { Tooltip } from '@base-ui/react/tooltip';
import { useT } from '../i18n';
import { Centre } from './Centre';
import { BakeDialog } from './bake/BakeDialog';
import { RenderDialog } from './render/RenderDialog';
import { VideoDialog } from './timeline/VideoDialog';
import { CommandPalette } from './CommandPalette';
import { Dialogs } from './Dialogs';
import { NewDocDialog } from './minecraft/NewDocDialog';
import { ModelImportDialogs } from './modelImport/ModelImportDialogs';
import { Outliner } from './Outliner';
import { Preferences } from './Preferences';
import { Properties } from './Properties';
import { StatusBar } from './StatusBar';
import { toastManager } from './toast';
import { Toasts } from './Toasts';
import { ToolRail } from './ToolRail';
import { TopBar } from './TopBar';
import { useFormatGuards } from './formatGuards';
import { useDocFormat } from './format';
import { ItemSidebar } from './items/ItemInspector';
import { ItemWizard } from './items/ItemWizard';
import { registerItemFileOpener } from './items/itemActions';
import { useEffect } from 'react';
import { useShortcuts } from './useShortcuts';
import { GitHubDialog } from './projects/GitHubDialog';
import { ProjectDialogs } from './projects/ProjectDialogs';
import { TextureLibraryPanel } from './library/TextureLibraryPanel';
import { useLibraryUi } from './library/libraryUi';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { useProjects } from './projects/projectsStore';

/** The editor shell. It subscribes to nothing but the UI language, so state changes only re-render the panels that care. */
export function App() {
  useShortcuts();
  useFormatGuards();
  const t = useT();
  const projectsOpen = useProjects((s) => s.panelOpen);
  const itemDefinition = useDocFormat() === 'minecraft_item';
  // Item definitions in the project tree open in the item editor.
  useEffect(() => registerItemFileOpener(), []);
  const libraryOpen = useLibraryUi((s) => s.panelOpen);
  const columns = ['44px', ...(projectsOpen ? ['248px'] : []), ...(libraryOpen ? ['272px'] : []), 'minmax(0,1fr)', '272px'].join('_');
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Tooltip.Provider delay={450} closeDelay={0}>
        <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <TopBar />
          <div className="grid min-h-0" style={{ gridTemplateColumns: columns.replaceAll('_', ' ') }}>
            <ToolRail />
            {projectsOpen && <ProjectsPanel />}
            {libraryOpen && <TextureLibraryPanel />}
            <Centre />
            <aside aria-label={t.app.sidebar} className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(7rem,2fr)_minmax(0,3fr)] border-l border-line bg-panel">
              {itemDefinition ? (
                <ItemSidebar />
              ) : (
                <>
                  <Outliner />
                  <Properties />
                </>
              )}
            </aside>
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
        <Toasts />
      </Tooltip.Provider>
    </Toast.Provider>
  );
}
