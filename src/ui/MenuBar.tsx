import { Menu } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import type { ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../app/store';
import { primitiveTypes } from '../core/mesh/primitives';
import { shadings, viewPresets } from '../core/types';
import { primitiveLabels, shadingLabels, viewLabels } from './labels';
import { ActionItem, MenuLabel, MenuPopup, MenuSeparator, RadioActionItem, Submenu } from './menu';

function TopMenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Menu.Root>
      <Menu.Trigger className="h-7 rounded-md px-2.5 text-[13px] text-dim outline-none hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text data-[popup-open]:bg-raised data-[popup-open]:text-text">
        {title}
      </Menu.Trigger>
      <MenuPopup>{children}</MenuPopup>
    </Menu.Root>
  );
}

// The menu contents subscribe to the store themselves and only exist while their menu is open.

function EditItems() {
  const canUndo = useApp((s) => selectActiveDoc(s).past.length > 0);
  const canRedo = useApp((s) => selectActiveDoc(s).future.length > 0);
  const hasSelection = useApp((s) => selectActiveDoc(s).state.selection.length > 0);
  const hasObjects = useApp((s) => selectActiveDoc(s).state.order.length > 0);
  return (
    <>
      <ActionItem id="edit.undo" disabled={!canUndo} />
      <ActionItem id="edit.redo" disabled={!canRedo} />
      <MenuSeparator />
      <ActionItem id="edit.duplicate" disabled={!hasSelection} />
      <ActionItem id="edit.delete" disabled={!hasSelection} />
      <MenuSeparator />
      <ActionItem id="edit.select_all" disabled={!hasObjects} />
      <ActionItem id="edit.deselect" disabled={!hasSelection} />
    </>
  );
}

function ViewItems() {
  const shading = useApp((s) => s.shading);
  return (
    <>
      <Menu.Group>
        <MenuLabel>Darstellung</MenuLabel>
        <Menu.RadioGroup value={shading}>
          {shadings.map((s) => (
            <RadioActionItem key={s} id={`shading.${s}`} value={s} title={shadingLabels[s].title} />
          ))}
        </Menu.RadioGroup>
      </Menu.Group>
      <ActionItem id="shading.cycle" title="Nächste Darstellung" />
      <MenuSeparator />
      <Menu.Group>
        <MenuLabel>Blickrichtung</MenuLabel>
        {viewPresets.map((preset) => (
          <ActionItem key={preset} id={`view.${preset}`} title={viewLabels[preset]} />
        ))}
      </Menu.Group>
      <MenuSeparator />
      <ActionItem id="view.frame" />
      <MenuSeparator />
      <ActionItem id="palette.open" title="Befehlspalette…" />
    </>
  );
}

export function AddItems() {
  return (
    <>
      {primitiveTypes.map((type) => (
        <ActionItem key={type} id={`add.${type}`} title={primitiveLabels[type].title} icon={primitiveLabels[type].icon} />
      ))}
    </>
  );
}

export function MenuBar() {
  return (
    <Menubar className="flex items-center gap-0.5">
      <TopMenu title="Datei">
        <ActionItem id="file.new" />
        <ActionItem id="file.open" />
        <MenuSeparator />
        <ActionItem id="file.save" />
        <ActionItem id="file.save_as" />
        <Submenu title="Exportieren">
          <ActionItem id="file.export_glb" title="GLB (binär)" />
          <ActionItem id="file.export_gltf" title="glTF (JSON)" />
        </Submenu>
        <MenuSeparator />
        <ActionItem id="file.close" />
      </TopMenu>
      <TopMenu title="Bearbeiten">
        <EditItems />
      </TopMenu>
      <TopMenu title="Hinzufügen">
        <AddItems />
      </TopMenu>
      <TopMenu title="Ansicht">
        <ViewItems />
      </TopMenu>
    </Menubar>
  );
}
