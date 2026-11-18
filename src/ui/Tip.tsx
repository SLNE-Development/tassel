import { Tooltip } from '@base-ui/react/tooltip';
import type { ReactElement } from 'react';

/** Tooltip with an optional shortcut hint. `children` must be a single element that accepts a ref. */
export function Tip({
  label,
  shortcut,
  side = 'bottom',
  children,
}: {
  label: string;
  shortcut?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner side={side} sideOffset={8} className="z-60">
          <Tooltip.Popup className="flex items-center gap-2 rounded-md border border-line-strong bg-overlay px-2 py-1 text-[12px] text-text shadow-pop">
            {label}
            {shortcut && <kbd className="tnum rounded border border-line-strong px-1 font-sans text-[11px] text-dim">{shortcut}</kbd>}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
