import { Menu } from '@base-ui/react/menu';
import { Plus } from 'lucide-react';
import { selectDocState, useApp } from '../app/store';
import { shadings, tools } from '../core/types';
import { useT } from '../i18n';
import { getAction, runAction, shortcutLabel } from './actions';
import { meshToolIcons, shadingIcons, toolIcons } from './labels';
import { MenuPopup } from './menu';
import { AddItems, MergeItems } from './MenuBar';
import { Tip } from './Tip';
import { useUi } from './uiStore';

const buttonClass = (active: boolean) =>
  `rail-button relative flex shrink-0 items-center justify-center rounded-md ${
    active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'
  }`;

function Tools() {
  const tool = useApp((s) => s.tool);
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t.toolRail.tool} className="rail-group flex flex-col">
      {tools.map((id) => {
        const title = t.tools[id];
        const Icon = toolIcons[id];
        const active = id === tool;
        return (
          <Tip key={id} label={title} shortcut={shortcutLabel(`tool.${id}`)} side="right">
            <button role="radio" aria-checked={active} aria-label={title} className={buttonClass(active)} onClick={() => void runAction(`tool.${id}`)}>
              {active && <span aria-hidden className="absolute top-1.5 bottom-1.5 -left-1.5 w-0.5 rounded-full bg-accent" />}
              <Icon size={17} strokeWidth={1.75} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

function AddButton() {
  const open = useUi((s) => s.addMenuOpen);
  const t = useT();
  return (
    <Menu.Root open={open} onOpenChange={(next) => useUi.setState({ addMenuOpen: next })}>
      <Tip label={t.toolRail.addObject} shortcut={shortcutLabel('add.menu')} side="right">
        <Menu.Trigger
          aria-label={t.toolRail.addObject}
          className="rail-button flex shrink-0 items-center justify-center rounded-md border border-line-strong text-text hover:border-accent hover:text-accent data-[popup-open]:border-accent data-[popup-open]:text-accent"
        >
          <Plus size={17} strokeWidth={1.75} />
        </Menu.Trigger>
      </Tip>
      <MenuPopup side="right">
        <AddItems />
      </MenuPopup>
    </Menu.Root>
  );
}

function Shading() {
  const shading = useApp((s) => s.shading);
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t.toolRail.shading} className="rail-group flex flex-col">
      {shadings.map((s) => {
        const title = t.actions.shading(t.shadings[s]);
        const Icon = shadingIcons[s];
        const active = s === shading;
        return (
          <Tip key={s} label={title} shortcut={active ? undefined : shortcutLabel('shading.cycle')} side="right">
            <button role="radio" aria-checked={active} aria-label={title} className={buttonClass(active)} onClick={() => void runAction(`shading.${s}`)}>
              <Icon size={16} strokeWidth={1.75} fill={s === 'solid' ? 'currentColor' : 'none'} />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

const meshTools = ['mesh.extrude', 'mesh.inset', 'mesh.bevel', 'mesh.loop_cut', 'mesh.subdivide', 'mesh.merge_menu', 'mesh.fill', 'mesh.flip_normals', 'mesh.delete'];

/** The mesh operations of edit mode. Each runs at once; its parameters follow in the "Letzte Aktion" panel. */
function MeshTools() {
  const mergeOpen = useUi((s) => s.mergeMenuOpen);
  const t = useT();
  return (
    <div role="group" aria-label={t.toolRail.meshTools} className="rail-group flex flex-col">
      {meshTools.map((id) => {
        const { title } = getAction(id);
        const Icon = meshToolIcons[id];
        if (id !== 'mesh.merge_menu') {
          return (
            <Tip key={id} label={title} shortcut={shortcutLabel(id)} side="right">
              <button aria-label={title} className={buttonClass(false)} onClick={() => void runAction(id)}>
                <Icon size={16} strokeWidth={1.75} />
              </button>
            </Tip>
          );
        }
        return (
          <Menu.Root key={id} open={mergeOpen} onOpenChange={(next) => useUi.setState({ mergeMenuOpen: next })}>
            <Tip label={title} shortcut={shortcutLabel(id)} side="right">
              <Menu.Trigger aria-label={title} className={`${buttonClass(false)} data-[popup-open]:bg-raised data-[popup-open]:text-accent`}>
                <Icon size={16} strokeWidth={1.75} />
              </Menu.Trigger>
            </Tip>
            <MenuPopup side="right">
              <MergeItems />
            </MenuPopup>
          </Menu.Root>
        );
      })}
    </div>
  );
}

export function ToolRail() {
  const editing = useApp((s) => selectDocState(s).edit !== null);
  const t = useT();
  return (
    <nav aria-label={t.toolRail.tools} className="no-scrollbar flex flex-col items-center gap-2 overflow-y-auto border-r border-line bg-panel py-2">
      <Tools />
      <div aria-hidden className="h-px w-5 shrink-0 bg-line-strong" />
      {/* Adding an object would leave edit mode, so the rail offers the mesh tools instead. */}
      {editing ? <MeshTools /> : <AddButton />}
      <div className="flex-1" />
      <Shading />
    </nav>
  );
}
