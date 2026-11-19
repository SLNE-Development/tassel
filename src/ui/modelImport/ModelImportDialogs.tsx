import { Dialog } from '@base-ui/react/dialog';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { execute } from '../../app/store';
import type { ParentMode } from '../../core/minecraft/openModel';
import { useT } from '../../i18n';
import { PickMenu, Switch } from '../controls';
import { FieldRow } from '../minecraft/fields';
import { notifyError } from '../toast';
import { answerParentPrompt, useModelImport } from './modelImportFlows';

const popup =
  'anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(34rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-line-strong bg-overlay shadow-pop outline-none';
const text = 'text-[calc(12.5px*var(--font-scale))]';
const button = `h-8 rounded-md px-3.5 ${text} font-medium`;

function Frame({ title, open: isOpen, onClose, children }: { title: string; open: boolean; onClose(): void; children: ReactNode }) {
  const t = useT();
  return (
    <Dialog.Root open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className={popup}>
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          {isOpen && children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** After opening a Java model whose parent has elements: show it, merge it in, or keep only the reference. */
function ParentPrompt() {
  const t = useT().modelImport.parent;
  const prompt = useModelImport((s) => s.parentPrompt);
  const [remember, setRemember] = useState(false);
  const choices: { mode: ParentMode; title: string; description: string }[] = [
    { mode: 'show', title: t.show, description: t.showText },
    { mode: 'merge', title: t.merge, description: t.mergeText },
    { mode: 'reference', title: t.reference, description: t.referenceText },
  ];
  return (
    <Frame title={t.title} open={prompt !== null} onClose={() => void answerParentPrompt('show', false)}>
      <div className="flex flex-col gap-2 px-5 py-4">
        <p className={`${text} text-dim`}>{t.prompt(prompt?.parent ?? '')}</p>
        {choices.map((choice) => (
          <button
            key={choice.mode}
            type="button"
            onClick={() => void answerParentPrompt(choice.mode, remember)}
            className="flex flex-col gap-0.5 rounded-lg border border-line-strong p-3 text-left hover:border-accent hover:bg-raised/60"
          >
            <span className={`${text} font-medium text-text`}>{choice.title}</span>
            <span className="text-[calc(12px*var(--font-scale))] leading-snug text-dim">{choice.description}</span>
          </button>
        ))}
        <label className={`mt-1 flex items-center gap-2 ${text} text-dim`}>
          <Switch label={t.remember} checked={remember} onChange={setRemember} />
          {t.remember}
        </label>
      </div>
    </Frame>
  );
}

interface Summary {
  converted: { source: string; output: string; warnings: string[] }[];
  skipped: { source: string; reason: string }[];
  failed: { source: string; error: string }[];
}

const shortName = (path: string) => path.split(/[\\/]/).slice(-2).join('/');

function FolderField({ value, placeholder, onPick, label }: { value: string; placeholder: string; label: string; onPick(path: string): void }) {
  const t = useT().modelImport.folder;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className={`min-w-0 flex-1 truncate ${text} ${value ? 'text-text' : 'text-faint'}`} title={value}>
        {value || placeholder}
      </span>
      <button
        type="button"
        aria-label={label}
        className={`flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 ${text} text-text hover:border-accent hover:text-accent`}
        onClick={async () => {
          const chosen = await open({ directory: true, multiple: false }).catch(notifyError);
          if (typeof chosen === 'string') onPick(chosen);
        }}
      >
        <FolderOpen size={13} strokeWidth={1.75} />
        {t.browse}
      </button>
    </div>
  );
}

/** File > Import Folder: converts every .json / .bbmodel in a folder to .tessel or Java JSON. */
function ImportFolderBody() {
  const t = useT().modelImport.folder;
  const [folder, setFolder] = useState('');
  const [output, setOutput] = useState('');
  const [target, setTarget] = useState<'tessel' | 'json'>('tessel');
  const [parent, setParent] = useState<ParentMode>('reference');
  const [recursive, setRecursive] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);

  const run = async () => {
    setRunning(true);
    setSummary(null);
    try {
      setSummary((await execute('document.convert_models', { folder, ...(output ? { output } : {}), target, recursive, overwrite, parent })) as Summary);
    } catch (error) {
      notifyError(error);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 px-5 pt-4">
        <FieldRow title={t.source}>
          <FolderField label={t.source} value={folder} placeholder={t.chooseFolder} onPick={setFolder} />
        </FieldRow>
        <FieldRow title={t.output}>
          <FolderField label={t.output} value={output} placeholder={t.sameFolder} onPick={setOutput} />
        </FieldRow>
        <FieldRow title={t.target}>
          <PickMenu
            label={t.target}
            value={target}
            placeholder={t.tessel}
            options={[
              { value: 'tessel', title: t.tessel },
              { value: 'json', title: t.json },
            ]}
            onChange={(v) => setTarget(v as 'tessel' | 'json')}
          />
        </FieldRow>
        <FieldRow title={t.parent}>
          <PickMenu
            label={t.parent}
            value={parent}
            placeholder={t.parentReference}
            options={[
              { value: 'reference', title: t.parentReference },
              { value: 'merge', title: t.parentMerge },
              { value: 'show', title: t.parentShow },
            ]}
            onChange={(v) => setParent(v as ParentMode)}
          />
        </FieldRow>
        <FieldRow title={t.recursive}>
          <Switch label={t.recursive} checked={recursive} onChange={setRecursive} />
        </FieldRow>
        <FieldRow title={t.overwrite}>
          <Switch label={t.overwrite} checked={overwrite} onChange={setOverwrite} />
        </FieldRow>
      </div>
      {summary && (
        <div className="mx-5 mt-4 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-line p-2.5">
          <p className={`${text} font-medium text-text`}>{t.summary(summary.converted.length, summary.skipped.length, summary.failed.length)}</p>
          <ul className="flex flex-col gap-0.5 text-[calc(12px*var(--font-scale))] text-dim">
            {summary.failed.map((f) => (
              <li key={f.source} className="text-danger">
                {t.failed}: {shortName(f.source)} — {f.error}
              </li>
            ))}
            {summary.converted.map((c) => (
              <li key={c.source} title={c.warnings.join('\n')}>
                {t.converted}: {shortName(c.source)} → {shortName(c.output)}
                {c.warnings.length > 0 && <span className="text-faint"> ({t.notes(c.warnings.length)})</span>}
              </li>
            ))}
            {summary.skipped.map((s) => (
              <li key={s.source} className="text-faint">
                {t.skipped}: {shortName(s.source)} — {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <footer className="mt-5 flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Dialog.Close type="button" className={`${button} text-dim hover:bg-raised hover:text-text`}>
          {t.close}
        </Dialog.Close>
        <button type="button" disabled={!folder || running} onClick={() => void run()} className={`${button} bg-accent text-accent-ink hover:brightness-110 disabled:opacity-50`}>
          {running ? t.running : t.run}
        </button>
      </footer>
    </div>
  );
}

export function ModelImportDialogs() {
  const t = useT().modelImport;
  const folderOpen = useModelImport((s) => s.folderOpen);
  return (
    <>
      <ParentPrompt />
      <Frame title={t.folder.title} open={folderOpen} onClose={() => useModelImport.setState({ folderOpen: false })}>
        <ImportFolderBody />
      </Frame>
    </>
  );
}
