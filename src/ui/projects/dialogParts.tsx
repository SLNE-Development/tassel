import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../i18n';

// Shared look of the Projects dialogs (same frame as the preferences dialog).

const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium disabled:opacity-50 disabled:pointer-events-none';
export const quietButton = `${buttonBase} text-dim hover:bg-raised hover:text-text`;
export const primaryButton = `${buttonBase} bg-accent text-accent-ink hover:brightness-110`;
export const dangerButton = `${buttonBase} text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/12`;
export const outlineButton = `${buttonBase} text-text ring-1 ring-line-strong ring-inset hover:bg-raised`;
export const inputClass =
  'h-8 w-full min-w-0 rounded-md bg-ink px-2.5 text-[calc(13px*var(--font-scale))] text-text ring-1 ring-line ring-inset outline-none placeholder:text-faint focus:ring-accent';
export const labelClass = 'text-[calc(12.5px*var(--font-scale))] text-dim';

export function ProjectDialog({
  open,
  onClose,
  title,
  width = '28rem',
  children,
  footer,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  width?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup
          className="anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none"
          style={{ width: `min(${width}, calc(100% - 2rem))` }}
        >
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">{footer}</footer>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
