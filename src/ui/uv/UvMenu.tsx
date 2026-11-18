import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Menu } from '@base-ui/react/menu';
import { Eraser, FlipHorizontal2, FlipVertical2, LayoutGrid, RotateCcw, RotateCw, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { unwrapMethods } from '../../core/mesh/uv';
import { useT } from '../../i18n';
import { dispatch, shortcutLabel } from '../actions';
import { ActionItem, MenuLabel, MenuSeparator, popupClass, Submenu } from '../menu';
import { useUvUi, uvObject } from './uvStore';

/** Icons of the UV tools, by action id. */
export const uvIcons: Record<string, LucideIcon> = {
  'uv.pack': LayoutGrid,
  'uv.rotate_left': RotateCcw,
  'uv.rotate_right': RotateCw,
  'uv.flip_horizontal': FlipHorizontal2,
  'uv.flip_vertical': FlipVertical2,
  'uv.clear': Eraser,
};

export const uvTools = ['uv.pack', 'uv.rotate_left', 'uv.rotate_right', 'uv.flip_horizontal', 'uv.flip_vertical'] as const;

/** The unwrap methods as menu items. */
export function UnwrapItems() {
  const t = useT();
  return (
    <>
      {unwrapMethods.map((method) => (
        <ActionItem key={method} id={`uv.unwrap_${method}`} title={t.uv.methods[method]} />
      ))}
    </>
  );
}

/** Contents of the "UV" menu of the menu bar. */
export function UvMenuItems() {
  const hasObject = useApp((s) => uvObject(selectDocState(s)) !== undefined);
  const hasUvs = useApp((s) => uvObject(selectDocState(s))?.mesh.uvs !== undefined);
  const t = useT();
  return (
    <>
      {hasObject ? (
        <Submenu title={t.uv.unwrap} shortcut={shortcutLabel('uv.unwrap_menu')}>
          <UnwrapItems />
        </Submenu>
      ) : (
        <ActionItem id="uv.unwrap_menu" disabled />
      )}
      <ActionItem id="uv.pack" icon={uvIcons['uv.pack']} disabled={!hasUvs} />
      <MenuSeparator />
      {uvTools.slice(1).map((id) => (
        <ActionItem key={id} id={id} icon={uvIcons[id]} disabled={!hasUvs} />
      ))}
      <MenuSeparator />
      <ActionItem id="uv.clear" icon={uvIcons['uv.clear']} disabled={!hasUvs} />
    </>
  );
}

/** The unwrap menu at the pointer, opened by its shortcut. */
function UnwrapAtPointer() {
  const at = useUvUi((s) => s.unwrapMenuAt);
  const t = useT();
  const anchor = useMemo(() => ({ getBoundingClientRect: () => new DOMRect(at?.x ?? 0, at?.y ?? 0, 0, 0) }), [at]);
  return (
    <Menu.Root open={at !== null} onOpenChange={(open) => !open && useUvUi.setState({ unwrapMenuAt: null })}>
      <Menu.Portal>
        <Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>
            <Menu.Group>
              <MenuLabel>{t.uv.unwrap}</MenuLabel>
              <UnwrapItems />
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium';

function ClearConfirm() {
  const open = useUvUi((s) => s.clearConfirmOpen);
  const name = useApp((s) => uvObject(selectDocState(s))?.name ?? '');
  const t = useT();
  const close = () => useUvUi.setState({ clearConfirmOpen: false });
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <AlertDialog.Popup className="anim-pop fixed top-[24vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop">
          <AlertDialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.uv.clearTitle}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{t.uv.clearText(name)}</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={`${buttonBase} mr-auto text-dim hover:bg-raised hover:text-text`}>{t.dialogs.cancel}</AlertDialog.Close>
            <button
              className={`${buttonBase} text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/12`}
              onClick={() => {
                close();
                void dispatch('uv.clear');
              }}
            >
              {t.uv.clear}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** Overlays of the UV tools that can open in any workspace. */
export function UvOverlays() {
  return (
    <>
      <UnwrapAtPointer />
      <ClearConfirm />
    </>
  );
}
