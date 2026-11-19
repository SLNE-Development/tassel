import { Dialog } from '@base-ui/react/dialog';
import { Box, Factory, FileJson, Shapes, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { execute } from '../../app/store';
import { factoryTemplates, type FactoryTemplate } from '../../core/minecraft/factory/templates';
import { DEFAULT_VERSION, javaVersions } from '../../core/minecraft/versions';
import type { DocFormat } from '../../core/types';
import { useT } from '../../i18n';
import { PickMenu, Switch } from '../controls';
import { ScrubField } from '../ScrubField';
import { notifyError } from '../toast';
import { useUi } from '../uiStore';
import { FieldRow } from './fields';
import { openItemWizard } from '../items/itemActions';

const parentSuggestions = ['block/block', 'block/cube', 'block/cube_all', 'block/cube_column', 'item/generated', 'item/handheld', 'builtin/entity'];

const inputClass =
  'h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent';

/** The settings a new Minecraft Java document starts with; also what the dialog resets to. */
const initialJava = { fileName: '', parent: '', ambientOcclusion: true, textureSize: [16, 16] as [number, number], version: DEFAULT_VERSION };

function FormatCard({ icon, title, description, selected, onSelect }: { icon: ReactNode; title: string; description: string; selected: boolean; onSelect(): void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-left ${
        selected ? 'border-accent bg-raised' : 'border-line-strong hover:border-faint hover:bg-raised/60'
      }`}
    >
      <span className={`flex items-center gap-2 text-[calc(13px*var(--font-scale))] font-medium ${selected ? 'text-accent' : 'text-text'}`}>
        {icon}
        {title}
      </span>
      <span className="text-[calc(12px*var(--font-scale))] leading-snug text-dim">{description}</span>
    </button>
  );
}

function NewDocBody({ close }: { close(): void }) {
  const t = useT().mc.newDoc;
  const tf = useT().factory.newDoc;
  const items = useT().items;
  const [format, setFormat] = useState<DocFormat>('free');
  const [machineId, setMachineId] = useState('');
  const [template, setTemplate] = useState<FactoryTemplate>('machine');
  const [java, setJava] = useState(initialJava);
  const patch = (changes: Partial<typeof initialJava>) => setJava((j) => ({ ...j, ...changes }));

  const create = () => {
    close();
    const params =
      format === 'free'
        ? undefined
        : {
            format,
            ...(java.fileName.trim() ? { fileName: java.fileName.trim() } : {}),
            parent: java.parent.trim(),
            ambientOcclusion: java.ambientOcclusion,
            textureSize: java.textureSize,
            version: java.version,
            ...(format === 'minecraft_factory' ? { template, ...(machineId.trim() ? { machineId: machineId.trim() } : {}) } : {}),
          };
    execute('document.new', params).catch(notifyError);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <div role="radiogroup" aria-label={t.format} className="grid grid-cols-2 gap-2 px-5 pt-4">
        <FormatCard icon={<Shapes size={15} strokeWidth={1.75} />} title={t.free} description={t.freeText} selected={format === 'free'} onSelect={() => setFormat('free')} />
        <FormatCard
          icon={<Box size={15} strokeWidth={1.75} />}
          title={t.java}
          description={t.javaText}
          selected={format === 'minecraft_java'}
          onSelect={() => setFormat('minecraft_java')}
        />
        <FormatCard
          icon={<Factory size={15} strokeWidth={1.75} />}
          title={tf.factory}
          description={tf.factoryText}
          selected={format === 'minecraft_factory'}
          onSelect={() => setFormat('minecraft_factory')}
        />
        {/* Item definitions have their own short wizard (id, base model, variants). */}
        <FormatCard
          icon={<FileJson size={15} strokeWidth={1.75} />}
          title={items.newDocTitle}
          description={items.newDocText}
          selected={false}
          onSelect={() => {
            close();
            openItemWizard();
          }}
        />
      </div>
      {format !== 'free' && (
        <div className="mt-4 flex flex-col gap-2.5 border-t border-line px-5 pt-4">
          <FieldRow title={t.fileName}>
            <input aria-label={t.fileName} className={inputClass} value={java.fileName} placeholder={t.fileNameHint} spellCheck={false} autoFocus onChange={(e) => patch({ fileName: e.currentTarget.value })} />
          </FieldRow>
          {format === 'minecraft_factory' && (
            <>
              <FieldRow title={tf.machineId}>
                <input aria-label={tf.machineId} className={inputClass} value={machineId} placeholder={tf.machineIdHint} spellCheck={false} onChange={(e) => setMachineId(e.currentTarget.value)} />
              </FieldRow>
              <FieldRow title={tf.template}>
                <PickMenu<FactoryTemplate>
                  label={tf.template}
                  value={template}
                  placeholder={tf.templates[template]}
                  options={factoryTemplates.map((id) => ({ value: id, title: tf.templates[id] }))}
                  onChange={setTemplate}
                />
              </FieldRow>
              <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{tf.templateText[template]}</p>
            </>
          )}
          <FieldRow title={t.parent}>
            <input
              aria-label={t.parent}
              className={inputClass}
              list="mc-parents"
              value={java.parent}
              placeholder={t.parentHint}
              spellCheck={false}
              onChange={(e) => patch({ parent: e.currentTarget.value })}
            />
            <datalist id="mc-parents">
              {parentSuggestions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </FieldRow>
          <FieldRow title={t.ambientOcclusion}>
            <Switch label={t.ambientOcclusion} checked={java.ambientOcclusion} onChange={(ambientOcclusion) => patch({ ambientOcclusion })} />
          </FieldRow>
          <FieldRow title={t.textureSize}>
            <div className="grid grid-cols-2 gap-1">
              {(['W', 'H'] as const).map((label, i) => (
                <ScrubField
                  key={label}
                  integer
                  label={label}
                  ariaLabel={`${t.textureSize} ${label}`}
                  color="var(--faint)"
                  value={java.textureSize[i]}
                  step={1}
                  min={1}
                  max={4096}
                  onCommit={(value) => patch({ textureSize: i === 0 ? [value, java.textureSize[1]] : [java.textureSize[0], value] })}
                />
              ))}
            </div>
          </FieldRow>
          <FieldRow title={t.version}>
            <PickMenu
              label={t.version}
              value={java.version}
              placeholder={java.version}
              options={javaVersions.map((v) => ({ value: v.id, title: v.label }))}
              onChange={(version) => patch({ version })}
            />
          </FieldRow>
        </div>
      )}
      <footer className="mt-5 flex items-center justify-end gap-2 border-t border-line px-5 py-3">
        <Dialog.Close type="button" className="h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-dim hover:bg-raised hover:text-text">
          {t.cancel}
        </Dialog.Close>
        <button type="submit" className="h-8 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110">
          {t.create}
        </button>
      </footer>
    </form>
  );
}

/** File > New: choose the kind of model, and for Minecraft Java its settings. */
export function NewDocDialog() {
  const t = useT();
  const open = useUi((s) => s.newDocOpen);
  const close = () => useUi.setState({ newDocOpen: false });
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(34rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-line-strong bg-overlay shadow-pop outline-none">
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.mc.newDoc.title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          {/* Mounted only while open, so every opening starts from the defaults. */}
          {open && <NewDocBody close={close} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
