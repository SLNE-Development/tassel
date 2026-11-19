import { Menu } from '@base-ui/react/menu';
import { Menubar } from '@base-ui/react/menubar';
import { Box, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../app/store';
import { primitiveTypes } from '../core/mesh/primitives';
import { anglePresets } from '../core/preview';
import { elementModes, shadings, viewPresets } from '../core/types';
import { useT } from '../i18n';
import { shortcutLabel } from './actions';
import { useIsMinecraft } from './format';
import { groupToUngroup } from './groupActions';
import { meshToolIcons, primitiveIcons } from './labels';
import { uvOps } from './minecraft/minecraftActions';
import { TimelineItems } from './timeline/TimelineMenu';
import { UvMenuItems } from './uv/UvMenu';
import { useProjects } from './projects/projectsStore';
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
  const minecraft = useIsMinecraft();
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
          {!minecraft && (
            <>
              <MenuSeparator />
              <ActionItem id="bake.open" disabled={!hasSelection} />
            </>
          )}
          <MenuSeparator />
          <ActionItem id="edit.select_all" disabled={!hasObjects} />
          <ActionItem id="edit.deselect" disabled={!hasSelection} />
        </>
      )}
      {!minecraft && (
        <>
          <MenuSeparator />
          <ActionItem id="mode.toggle" title={editing ? t.menu.objectMode : t.menu.editMode} disabled={!editing && !hasSelection} />
        </>
      )}
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
  const minecraft = useIsMinecraft();
  const t = useT();
  if (minecraft) return null;
  return (
    <TopMenu title={t.menu.mesh} disabled={!editing}>
      <MeshItems />
    </TopMenu>
  );
}

function ViewItems() {
  const shading = useApp((s) => s.shading);
  const minecraft = useIsMinecraft();
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
      <Submenu title={t.preview.anglesMenu}>
        {anglePresets.map((preset) => (
          <ActionItem key={preset} id={`preview.angle_${preset}`} title={t.preview.angles[preset]} />
        ))}
      </Submenu>
      <ActionItem id="preview.toggle_projection" />
      <MenuSeparator />
      <ActionItem id="view.frame" />
      <MenuSeparator />
      <ActionItem id="projects.toggle" />
      <ActionItem id="library.toggle" />
      <MenuSeparator />
      {!minecraft && (
        <>
          <TimelineItems />
          <MenuSeparator />
        </>
      )}
      <ActionItem id="palette.open" title={t.menu.palette} />
    </>
  );
}

export function AddItems() {
  const minecraft = useIsMinecraft();
  const t = useT();
  if (minecraft) return <ActionItem id="add.cuboid" title={t.mc.cube} icon={Box} />;
  return (
    <>
      {primitiveTypes.map((type) => (
        <ActionItem key={type} id={`add.${type}`} title={t.primitives[type]} icon={primitiveIcons[type]} />
      ))}
      <MenuSeparator />
      <ActionItem id="add.text" title={t.shapes.text} icon={Type} />
    </>
  );
}

/** The "Element" menu of Minecraft documents: what the "Netz" menu is to meshes. */
function ElementMenu() {
  const hasSelection = useApp((s) => selectActiveDoc(s).state.selection.length > 0);
  const minecraft = useIsMinecraft();
  const t = useT();
  if (!minecraft) return null;
  const axes = ['x', 'y', 'z'] as const;
  return (
    <TopMenu title={t.mc.menu} disabled={!hasSelection}>
      <Submenu title={t.mc.flipMenu}>
        {axes.map((axis) => (
          <ActionItem key={axis} id={`mc.flip_${axis}`} />
        ))}
      </Submenu>
      <Submenu title={t.mc.rotateMenu}>
        {axes.flatMap((axis) => [
          <ActionItem key={`${axis}+`} id={`mc.rotate_${axis}_plus`} />,
          <ActionItem key={`${axis}-`} id={`mc.rotate_${axis}_minus`} />,
        ])}
      </Submenu>
      <MenuSeparator />
      <ActionItem id="mc.center_pivot" />
      <ActionItem id="mc.center_block" />
      <MenuSeparator />
      <ActionItem id="mc.auto_cullface" />
      <ActionItem id="mc.remove_blank_faces" />
      <MenuSeparator />
      <ActionItem id="mc.validate" />
    </TopMenu>
  );
}

/** The UV menu: unwrap tools for meshes, face UV operations for elements. */
function UvMenuSwitch() {
  const minecraft = useIsMinecraft();
  if (!minecraft) return <UvMenuItems />;
  return (
    <>
      {uvOps.map((op) => (
        <ActionItem key={op} id={`mc.uv_${op}`} />
      ))}
    </>
  );
}

export function MenuBar() {
  const t = useT();
  const hasProject = useProjects((s) => s.activeId !== null && s.projects.some((p) => p.id === s.activeId));
  return (
    <Menubar className="flex items-center gap-0.5">
      <TopMenu title={t.menu.file}>
        <ActionItem id="file.new" />
        <ActionItem id="file.open" />
        <ActionItem id="file.open_java" />
        <ActionItem id="file.import" />
        <MenuSeparator />
        <ActionItem id="file.save" />
        <ActionItem id="file.save_as" />
        <ActionItem id="projects.save_into" disabled={!hasProject} />
        <Submenu title={t.menu.export}>
          <ActionItem id="file.export_glb" title={t.menu.exportGlb} />
          <ActionItem id="file.export_gltf" title={t.menu.exportGltf} />
          {(['obj', 'stl', 'ply', 'usdz'] as const).map((format) => (
            <ActionItem key={format} id={`file.export_${format}`} title={t.files.menu[format]} />
          ))}
          <ActionItem id="file.export_json" title={t.files.menu.json} />
        </Submenu>
        <ActionItem id="render.open" />
        <ActionItem id="video.export" />
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
      <ElementMenu />
      <TopMenu title={t.uv.menu}>
        <UvMenuSwitch />
      </TopMenu>
      <TopMenu title={t.menu.view}>
        <ViewItems />
      </TopMenu>
    </Menubar>
  );
}
