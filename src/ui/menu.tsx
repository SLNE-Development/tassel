import { Menu } from '@base-ui/react/menu';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { getAction, runAction, shortcutLabel } from './actions';

/** Shared look for all menus (menu bar, add menu). */

export const popupClass =
  'anim-pop min-w-52 rounded-lg border border-line-strong bg-overlay p-1 text-[13px] text-text shadow-pop outline-none';

export const itemClass =
  'flex h-7 items-center gap-2.5 rounded-[5px] pr-2 pl-2 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-ink data-[disabled]:text-faint data-[popup-open]:not-data-[highlighted]:bg-raised';

export function MenuPopup({ children, side = 'bottom' }: { children: ReactNode; side?: 'bottom' | 'right' }) {
  return (
    <Menu.Portal>
      <Menu.Positioner side={side} align="start" sideOffset={side === 'bottom' ? 5 : 8} className="z-50 outline-none">
        <Menu.Popup className={popupClass}>{children}</Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

function Slot({ icon: Icon }: { icon?: LucideIcon }) {
  return <span className="flex w-4 shrink-0 justify-center">{Icon && <Icon size={15} strokeWidth={1.75} />}</span>;
}

function Shortcut({ label }: { label?: string }) {
  if (!label) return null;
  return <span className="tnum ml-auto pl-6 text-[12px] opacity-60">{label}</span>;
}

/** Menu item bound to a UI action: title, shortcut label and behaviour all come from the action. */
export function ActionItem({
  id,
  title,
  icon,
  disabled,
}: {
  id: string;
  /** Overrides the action's title, e.g. a shorter one inside a labelled group. */
  title?: string;
  icon?: LucideIcon;
  disabled?: boolean;
}) {
  return (
    <Menu.Item className={itemClass} disabled={disabled} onClick={() => void runAction(id)}>
      <Slot icon={icon} />
      <span>{title ?? getAction(id).title}</span>
      <Shortcut label={shortcutLabel(id)} />
    </Menu.Item>
  );
}

export function RadioActionItem({ id, value, title }: { id: string; value: string; title: string }) {
  return (
    <Menu.RadioItem className={itemClass} value={value} closeOnClick onClick={() => void runAction(id)}>
      <span className="flex w-4 shrink-0 justify-center">
        <Menu.RadioItemIndicator>
          <Check size={14} strokeWidth={2.25} />
        </Menu.RadioItemIndicator>
      </span>
      <span>{title}</span>
      <Shortcut label={shortcutLabel(id)} />
    </Menu.RadioItem>
  );
}

export function Submenu({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className={itemClass}>
        <Slot />
        <span>{title}</span>
        <ChevronRight size={14} className="ml-auto opacity-60" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner side="right" align="start" sideOffset={2} alignOffset={-5} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>{children}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className="mx-1 my-1 h-px bg-line-strong" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <Menu.GroupLabel className="px-2 pt-1.5 pb-1 text-[12px] text-faint">{children}</Menu.GroupLabel>;
}
