import { AlertDialog } from '@base-ui/react/alert-dialog';
import type { ReactNode } from 'react';
import { execute, useApp } from '../app/store';
import { documentName, useT } from '../i18n';
import { saveActiveDoc } from './actions';
import { dirtyDocNames, quitNow } from './closeGuard';
import { notifyError } from './toast';
import { useUi } from './uiStore';

const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium';
const quietButton = `${buttonBase} text-dim hover:bg-raised hover:text-text`;
const dangerButton = `${buttonBase} text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/12`;
const primaryButton = `${buttonBase} bg-accent text-accent-ink hover:brightness-110`;

function Confirm({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose(): void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const t = useT();
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Popup className="anim-pop fixed top-[24vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop">
          <AlertDialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{children}</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={`${quietButton} mr-auto`}>{t.dialogs.cancel}</AlertDialog.Close>
            {actions}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function CloseDocDialog() {
  const id = useUi((s) => s.closeDocId);
  const t = useT();
  const name = useApp((s) => (id && s.docs[id] ? documentName(s.docs[id], t) : undefined));
  const close = () => useUi.setState({ closeDocId: null });

  const discard = () => {
    close();
    if (id) execute('document.close', { id }).catch(notifyError);
  };

  const saveAndClose = async () => {
    close();
    if (!id) return;
    try {
      // Saving works on the active document, so bring this one to the front first.
      await execute('document.switch', { id });
      if (await saveActiveDoc()) await execute('document.close', { id });
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <Confirm
      open={id !== null && name !== undefined}
      onClose={close}
      title={t.dialogs.unsavedTitle}
      actions={
        <>
          <button className={dangerButton} onClick={discard}>
            {t.dialogs.discard}
          </button>
          <button className={primaryButton} onClick={() => void saveAndClose()}>
            {t.dialogs.save}
          </button>
        </>
      }
    >
      {t.dialogs.unsavedText(name ?? '')}
    </Confirm>
  );
}

function QuitDialog() {
  const open = useUi((s) => s.quitOpen);
  const names = open ? dirtyDocNames() : [];
  const close = () => useUi.setState({ quitOpen: false });
  const t = useT();
  return (
    <Confirm
      open={open}
      onClose={close}
      title={t.dialogs.quitTitle}
      actions={
        <button
          className={dangerButton}
          onClick={() => {
            close();
            quitNow();
          }}
        >
          {t.dialogs.quitWithoutSaving}
        </button>
      }
    >
      {t.dialogs.quitText(names)}
    </Confirm>
  );
}

export function Dialogs() {
  return (
    <>
      <CloseDocDialog />
      <QuitDialog />
    </>
  );
}
