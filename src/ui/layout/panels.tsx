import { isMinecraftFormat } from '../../core/formats';
import { FolderTree, Images, ListTree, Paintbrush, SlidersHorizontal, SquareDashedMousePointer, TestTube, View, Grid3x3 } from 'lucide-react';
import { DisplayPanel } from '../display/DisplayPanel';
import { ItemInspector, TestInputs } from '../items/ItemInspector';
import { TextureLibraryPanel } from '../library/TextureLibraryPanel';
import { setLibraryPanelOpen, useLibraryUi } from '../library/libraryUi';
import { Outliner } from '../Outliner';
import { PaintPanel } from '../paint/PaintPanel';
import { PixelPanel } from '../pixel/PixelPanel';
import { ProjectsPanel } from '../projects/ProjectsPanel';
import { setPanelOpen as setProjectsPanelOpen, useProjects } from '../projects/projectsStore';
import { Properties } from '../Properties';
import { registerPanel, type PanelContext } from './registry';

// The built-in dockable panels and their default places. This reproduces the fixed layout the editor
// had before panels could be docked: Projects and the Texture library as columns on the left (both
// closed until opened), the Outliner over the Properties on the right, and in the Properties' place
// whatever the workspace and format edit instead (paint layers, pixel art, display transforms, items).

const item = (c: PanelContext) => c.format === 'minecraft_item';
const minecraft = (c: PanelContext) => isMinecraftFormat(c.format);

let registered = false;

export function registerBuiltInPanels(): void {
  if (registered) return;
  registered = true;
  registerPanel({
    id: 'projects',
    title: (t) => t.projects.title,
    icon: FolderTree,
    component: ProjectsPanel,
    side: 'left',
    column: 'projects',
    group: 'projects',
    order: 10,
    width: 248,
    open: false,
    shortcutAction: 'projects.toggle',
    binding: {
      isOpen: () => useProjects.getState().panelOpen,
      setOpen: setProjectsPanelOpen,
      subscribe: (listener) => useProjects.subscribe((s, p) => s.panelOpen !== p.panelOpen && listener()),
    },
  });
  registerPanel({
    id: 'library',
    title: (t) => t.library.title,
    icon: Images,
    component: TextureLibraryPanel,
    side: 'left',
    column: 'library',
    group: 'library',
    order: 20,
    width: 272,
    open: false,
    shortcutAction: 'library.toggle',
    binding: {
      isOpen: () => useLibraryUi.getState().panelOpen,
      setOpen: setLibraryPanelOpen,
      subscribe: (listener) => useLibraryUi.subscribe((s, p) => s.panelOpen !== p.panelOpen && listener()),
    },
  });
  const right = { side: 'right', column: 'sidebar', width: 272 } as const;
  registerPanel({ ...right, id: 'outliner', group: 'top', order: 30, weight: 2, title: (t) => t.outliner.title, icon: ListTree, component: Outliner, when: (c) => !item(c) });
  registerPanel({ ...right, id: 'item-inputs', group: 'top', order: 31, weight: 2, title: (t) => t.items.inputs.title, icon: TestTube, component: TestInputs, when: item });
  registerPanel({
    ...right,
    id: 'properties',
    group: 'bottom',
    order: 40,
    weight: 3,
    title: (t) => t.properties.title,
    icon: SlidersHorizontal,
    component: Properties,
    when: (c) => !item(c) && c.workspace !== 'paint' && !(c.workspace === 'display' && minecraft(c)),
  });
  registerPanel({ ...right, id: 'paint', group: 'bottom', order: 41, weight: 3, title: (t) => t.paint.panel, icon: Paintbrush, component: PaintPanel, when: (c) => !item(c) && c.workspace === 'paint' && !minecraft(c) });
  registerPanel({ ...right, id: 'pixel', group: 'bottom', order: 42, weight: 3, title: (t) => t.pixel.panel.title, icon: Grid3x3, component: PixelPanel, when: (c) => c.workspace === 'paint' && minecraft(c) });
  registerPanel({ ...right, id: 'display', group: 'bottom', order: 43, weight: 3, title: (t) => t.display.panel, icon: View, component: DisplayPanel, when: (c) => c.workspace === 'display' && minecraft(c) });
  registerPanel({ ...right, id: 'item-inspector', group: 'bottom', order: 44, weight: 3, title: (t) => t.items.inspector, icon: SquareDashedMousePointer, component: ItemInspector, when: item });
}
