import { Menu } from '@base-ui/react/menu';
import { Plus } from 'lucide-react';
import { useApp } from '../app/store';
import { shadings, tools } from '../core/types';
import { runAction, shortcutLabel } from './actions';
import { shadingLabels, toolLabels } from './labels';
import { MenuPopup } from './menu';
import { AddItems } from './MenuBar';
import { Tip } from './Tip';
import { useUi } from './uiStore';

const buttonClass = (active: boolean) =>
  `relative flex size-8 items-center justify-center rounded-md ${
    active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'
  }`;

function Tools() {
  const tool = useApp((s) => s.tool);
  return (
    <div role="radiogroup" aria-label="Werkzeug" className="flex flex-col gap-1">
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
          className="flex size-8 items-center justify-center rounded-md border border-line-strong text-text hover:border-accent hover:text-accent data-[popup-open]:border-accent data-[popup-open]:text-accent"
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
    <div role="radiogroup" aria-label="Darstellung" className="flex flex-col gap-1">
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

export function ToolRail() {
  return (
    <nav aria-label="Werkzeuge" className="flex flex-col items-center gap-2 border-r border-line bg-panel py-2">
      <Tools />
      <div aria-hidden className="h-px w-5 bg-line-strong" />
      <AddButton />
      <div className="flex-1" />
      <Shading />
    </nav>
  );
}
