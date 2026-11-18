import { Menu } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import type { ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../app/store';
import { primitiveTypes } from '../core/mesh/primitives';
import { elementModes, shadings, viewPresets } from '../core/types';
import { useT } from '../i18n';
import { shortcutLabel } from './actions';
import { groupToUngroup } from './groupActions';
import { meshToolIcons, primitiveIcons } from './labels';
import { UvMenuItems } from './uv/UvMenu';
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
  const canUngroup = useApp(() => groupToUngroup() !== null);
  const t = useT();
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
          <ActionItem id="mesh.select_none" title={t.menu.deselect} />
        </>
      ) : (
        <>
          <ActionItem id="edit.delete" disabled={!hasSelection} />
          <MenuSeparator />
          <ActionItem id="edit.group" disabled={!hasSelection} />
          <ActionItem id="edit.ungroup" disabled={!canUngroup} />
          <MenuSeparator />
          <ActionItem id="edit.select_all" disabled={!hasObjects} />
          <ActionItem id="edit.deselect" disabled={!hasSelection} />
        </>
      )}
      <MenuSeparator />
      <ActionItem id="mode.toggle" title={editing ? t.menu.objectMode : t.menu.editMode} disabled={!editing && !hasSelection} />
    </>
  );
}

export function MergeItems() {
  const t = useT();
  return (
    <>
      <ActionItem id="mesh.merge_center" title={t.menu.mergeCenter} />
      <ActionItem id="mesh.merge_first" title={t.menu.mergeFirst} />
      <ActionItem id="mesh.merge_last" title={t.menu.mergeLast} />
      <MenuSeparator />
      <ActionItem id="mesh.merge_by_distance" title={t.menu.mergeByDistance} />
    </>
  );
}

function MeshItems() {
  const mode = useApp((s) => selectActiveDoc(s).state.edit?.elementMode);
  const t = useT();
  return (
    <>
      <ActionItem id="mesh.extrude" icon={meshToolIcons['mesh.extrude']} />
      <ActionItem id="mesh.inset" icon={meshToolIcons['mesh.inset']} />
      <ActionItem id="mesh.bevel" icon={meshToolIcons['mesh.bevel']} />
      <ActionItem id="mesh.loop_cut" icon={meshToolIcons['mesh.loop_cut']} />
      <ActionItem id="mesh.subdivide" icon={meshToolIcons['mesh.subdivide']} />
      <Submenu title={t.menu.merge} icon={meshToolIcons['mesh.merge_menu']} shortcut={shortcutLabel('mesh.merge_menu')}>
        <MergeItems />
      </Submenu>
      <ActionItem id="mesh.fill" icon={meshToolIcons['mesh.fill']} />
      <ActionItem id="mesh.flip_normals" icon={meshToolIcons['mesh.flip_normals']} />
      <ActionItem id="mesh.delete" icon={meshToolIcons['mesh.delete']} />
      <MenuSeparator />
      <Menu.Group>
        <MenuLabel>{t.menu.select}</MenuLabel>
        <ActionItem id="mesh.select_all" title={t.menu.selectAll} />
        <ActionItem id="mesh.select_none" title={t.menu.selectNone} />
        <ActionItem id="mesh.select_invert" title={t.menu.selectInvert} />
        <ActionItem id="mesh.select_linked" title={t.menu.selectLinked} />
        <ActionItem id="mesh.select_more" title={t.menu.selectMore} />
        <ActionItem id="mesh.select_less" title={t.menu.selectLess} />
      </Menu.Group>
      <MenuSeparator />
      <Submenu title={t.menu.selectMode}>
        <Menu.RadioGroup value={mode ?? ''}>
          {elementModes.map((m) => (
            <RadioActionItem key={m} id={`element.${m}`} value={m} title={t.elements[m].title} />
          ))}
        </Menu.RadioGroup>
      </Submenu>
    </>
  );
}

function MeshMenu() {
  const editing = useApp((s) => selectActiveDoc(s).state.edit !== null);
  const t = useT();
  return (
    <TopMenu title={t.menu.mesh} disabled={!editing}>
      <MeshItems />
    </TopMenu>
  );
}

function ViewItems() {
  const shading = useApp((s) => s.shading);
  const t = useT();
  return (
    <>
      <Menu.Group>
        <MenuLabel>{t.menu.shading}</MenuLabel>
        <Menu.RadioGroup value={shading}>
          {shadings.map((s) => (
            <RadioActionItem key={s} id={`shading.${s}`} value={s} title={t.shadings[s]} />
          ))}
        </Menu.RadioGroup>
      </Menu.Group>
      <ActionItem id="shading.cycle" title={t.menu.nextShading} />
      <MenuSeparator />
      <Menu.Group>
        <MenuLabel>{t.menu.viewDirection}</MenuLabel>
        {viewPresets.map((preset) => (
          <ActionItem key={preset} id={`view.${preset}`} title={t.views[preset]} />
        ))}
      </Menu.Group>
      <MenuSeparator />
      <ActionItem id="view.frame" />
      <MenuSeparator />
      <ActionItem id="palette.open" title={t.menu.palette} />
    </>
  );
}

export function AddItems() {
  const t = useT();
  return (
    <>
      {primitiveTypes.map((type) => (
        <ActionItem key={type} id={`add.${type}`} title={t.primitives[type]} icon={primitiveIcons[type]} />
      ))}
    </>
  );
}

export function MenuBar() {
  const t = useT();
  return (
    <Menubar className="flex items-center gap-0.5">
      <TopMenu title={t.menu.file}>
        <ActionItem id="file.new" />
        <ActionItem id="file.open" />
        <ActionItem id="file.import" />
        <MenuSeparator />
        <ActionItem id="file.save" />
        <ActionItem id="file.save_as" />
        <Submenu title={t.menu.export}>
          <ActionItem id="file.export_glb" title={t.menu.exportGlb} />
          <ActionItem id="file.export_gltf" title={t.menu.exportGltf} />
          {(['obj', 'stl', 'ply', 'usdz'] as const).map((format) => (
            <ActionItem key={format} id={`file.export_${format}`} title={t.files.menu[format]} />
          ))}
        </Submenu>
        <MenuSeparator />
        <ActionItem id="preferences.open" />
        <MenuSeparator />
        <ActionItem id="file.close" />
      </TopMenu>
      <TopMenu title={t.menu.edit}>
        <EditItems />
      </TopMenu>
      <TopMenu title={t.menu.add}>
        <AddItems />
      </TopMenu>
      <MeshMenu />
      <TopMenu title={t.uv.menu}>
        <UvMenuItems />
      </TopMenu>
      <TopMenu title={t.menu.view}>
        <ViewItems />
      </TopMenu>
    </Menubar>
  );
}
