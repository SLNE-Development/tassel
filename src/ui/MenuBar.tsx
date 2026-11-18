import { Menu } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import type { ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../app/store';
import { primitiveTypes } from '../core/mesh/primitives';
import { elementModes, shadings, viewPresets } from '../core/types';
import { shortcutLabel } from './actions';
import { elementLabels, meshToolIcons, primitiveLabels, shadingLabels, viewLabels } from './labels';
import { ActionItem, MenuLabel, MenuPopup, MenuSeparator, RadioActionItem, Submenu } from './menu';

function TopMenu({ title, disabled, children }: { title: string; disabled?: boolean; children: ReactNode }) {
  return (
    <Menu.Root disabled={disabled}>
      <Menu.Trigger className="h-7 rounded-md px-2.5 text-[calc(13px*var(--font-scale))] text-dim outline-none hover:bg-raised hover:text-text focus-visible:bg-raised focus-visible:text-text data-[disabled]:pointer-events-none data-[disabled]:text-faint/60 data-[popup-open]:bg-raised data-[popup-open]:text-text">
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
  const editing = useApp((s) => selectActiveDoc(s).state.edit !== null);
  return (
    <>
      <ActionItem id="edit.undo" disabled={!canUndo} />
      <ActionItem id="edit.redo" disabled={!canRedo} />
      <MenuSeparator />
      <ActionItem id="edit.duplicate" disabled={editing || !hasSelection} />
      {/* In edit mode these act on the mesh elements, like their shortcuts. */}
      {editing ? (
        <>
          <ActionItem id="mesh.delete" />
          <MenuSeparator />
          <ActionItem id="mesh.select_all" />
          <ActionItem id="mesh.select_none" title="Auswahl aufheben" />
        </>
      ) : (
        <>
          <ActionItem id="edit.delete" disabled={!hasSelection} />
          <MenuSeparator />
          <ActionItem id="edit.select_all" disabled={!hasObjects} />
          <ActionItem id="edit.deselect" disabled={!hasSelection} />
        </>
      )}
      <MenuSeparator />
      <ActionItem id="mode.toggle" title={editing ? 'Objektmodus' : 'Bearbeitungsmodus'} disabled={!editing && !hasSelection} />
    </>
  );
}

export function MergeItems() {
  return (
    <>
      <ActionItem id="mesh.merge_center" title="Mitte" />
      <ActionItem id="mesh.merge_first" title="Erster" />
      <ActionItem id="mesh.merge_last" title="Letzter" />
      <MenuSeparator />
      <ActionItem id="mesh.merge_by_distance" title="Nach Abstand" />
    </>
  );
}

function MeshItems() {
  const mode = useApp((s) => selectActiveDoc(s).state.edit?.elementMode);
  return (
    <>
      <ActionItem id="mesh.extrude" icon={meshToolIcons['mesh.extrude']} />
      <ActionItem id="mesh.inset" icon={meshToolIcons['mesh.inset']} />
      <ActionItem id="mesh.bevel" icon={meshToolIcons['mesh.bevel']} />
      <ActionItem id="mesh.loop_cut" icon={meshToolIcons['mesh.loop_cut']} />
      <ActionItem id="mesh.subdivide" icon={meshToolIcons['mesh.subdivide']} />
      <Submenu title="Verschmelzen" icon={meshToolIcons['mesh.merge_menu']} shortcut={shortcutLabel('mesh.merge_menu')}>
        <MergeItems />
      </Submenu>
      <ActionItem id="mesh.fill" icon={meshToolIcons['mesh.fill']} />
      <ActionItem id="mesh.flip_normals" icon={meshToolIcons['mesh.flip_normals']} />
      <ActionItem id="mesh.delete" icon={meshToolIcons['mesh.delete']} />
      <MenuSeparator />
      <Menu.Group>
        <MenuLabel>Auswählen</MenuLabel>
        <ActionItem id="mesh.select_all" title="Alles" />
        <ActionItem id="mesh.select_none" title="Nichts" />
        <ActionItem id="mesh.select_invert" title="Umkehren" />
        <ActionItem id="mesh.select_linked" title="Verbundene" />
        <ActionItem id="mesh.select_more" title="Mehr" />
        <ActionItem id="mesh.select_less" title="Weniger" />
      </Menu.Group>
      <MenuSeparator />
      <Submenu title="Auswahlmodus">
        <Menu.RadioGroup value={mode ?? ''}>
          {elementModes.map((m) => (
            <RadioActionItem key={m} id={`element.${m}`} value={m} title={elementLabels[m].title} />
          ))}
        </Menu.RadioGroup>
      </Submenu>
    </>
  );
}

function MeshMenu() {
  const editing = useApp((s) => selectActiveDoc(s).state.edit !== null);
  return (
    <TopMenu title="Netz" disabled={!editing}>
      <MeshItems />
    </TopMenu>
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
      <MeshMenu />
      <TopMenu title="Ansicht">
        <ViewItems />
      </TopMenu>
    </Menubar>
  );
}
