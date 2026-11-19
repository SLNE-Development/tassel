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
import { useShortcuts } from './useShortcuts';
import { GitHubDialog } from './projects/GitHubDialog';
import { ProjectDialogs } from './projects/ProjectDialogs';
import { ProjectsPanel } from './projects/ProjectsPanel';
import { useProjects } from './projects/projectsStore';

/** The editor shell. It subscribes to nothing but the UI language, so state changes only re-render the panels that care. */
export function App() {
  useShortcuts();
  useFormatGuards();
  const t = useT();
  const projectsOpen = useProjects((s) => s.panelOpen);
  return (
    <Toast.Provider toastManager={toastManager} limit={4}>
      <Tooltip.Provider delay={450} closeDelay={0}>
        <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <TopBar />
          <div className={`grid min-h-0 ${projectsOpen ? 'grid-cols-[44px_248px_minmax(0,1fr)_272px]' : 'grid-cols-[44px_minmax(0,1fr)_272px]'}`}>
            <ToolRail />
            {projectsOpen && <ProjectsPanel />}
            <Centre />
            <aside aria-label={t.app.sidebar} className="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(7rem,2fr)_minmax(0,3fr)] border-l border-line bg-panel">
              <Outliner />
              <Properties />
            </aside>
          </div>
          <StatusBar />
        </div>
        <CommandPalette />
        <Dialogs />
        <NewDocDialog />
        <ModelImportDialogs />
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
