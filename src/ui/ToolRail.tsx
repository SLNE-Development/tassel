import { Menu } from '@base-ui/react/menu';
import { Plus } from 'lucide-react';
import { selectDocState, useApp } from '../app/store';
import { shadings, tools } from '../core/types';
import { getAction, runAction, shortcutLabel } from './actions';
import { meshToolIcons, shadingLabels, toolLabels } from './labels';
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
  return (
    <div role="radiogroup" aria-label="Werkzeug" className="rail-group flex flex-col">
      {tools.map((t) => {
        const { title, icon: Icon } = toolLabels[t];
        const active = t === tool;
        return (
          <Tip key={t} label={title} shortcut={shortcutLabel(`tool.${t}`)} side="right">
            <button role="radio" aria-checked={active} aria-label={title} className={buttonClass(active)} onClick={() => void runAction(`tool.${t}`)}>
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
  return (
    <Menu.Root open={open} onOpenChange={(next) => useUi.setState({ addMenuOpen: next })}>
      <Tip label="Objekt hinzufügen" shortcut={shortcutLabel('add.menu')} side="right">
        <Menu.Trigger
          aria-label="Objekt hinzufügen"
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
  return (
    <div role="radiogroup" aria-label="Darstellung" className="rail-group flex flex-col">
      {shadings.map((s) => {
        const { title, icon: Icon } = shadingLabels[s];
        const active = s === shading;
        return (
          <Tip key={s} label={`Darstellung: ${title}`} shortcut={active ? undefined : shortcutLabel('shading.cycle')} side="right">
            <button role="radio" aria-checked={active} aria-label={`Darstellung: ${title}`} className={buttonClass(active)} onClick={() => void runAction(`shading.${s}`)}>
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
  return (
    <div role="group" aria-label="Netzwerkzeuge" className="rail-group flex flex-col">
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
  return (
    <nav aria-label="Werkzeuge" className="no-scrollbar flex flex-col items-center gap-2 overflow-y-auto border-r border-line bg-panel py-2">
      <Tools />
      <div aria-hidden className="h-px w-5 shrink-0 bg-line-strong" />
      {/* Adding an object would leave edit mode, so the rail offers the mesh tools instead. */}
      {editing ? <MeshTools /> : <AddButton />}
      <div className="flex-1" />
      <Shading />
    </nav>
  );
}
