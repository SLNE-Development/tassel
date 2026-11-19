// The quick way to the common case: one item that shows a base model, plus custom_model_data variants.
// Also "Create item definition for this model" (from a Minecraft Java document) and "Replace with variants".
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { execute, selectActiveDoc, useApp } from '../../app/store';
import { itemIdProblem } from '../../core/minecraft/items/document';
import { variantModes, type VariantMode } from '../../core/minecraft/items/templates';
import { useT } from '../../i18n';
import { Segmented } from '../controls';
import { FieldRow } from '../minecraft/fields';
import { ProjectDialog, inputClass as dialogInput, primaryButton, quietButton } from '../projects/dialogParts';
import { notifyError } from '../toast';
import { iconButton, SuggestField } from './fieldEditors';
import { useItemUi, selectNode, type WizardState } from './itemStore';
import { modelCatalog, packContext } from './packAssets';
import { useEffect } from 'react';

interface Row {
  model: string;
  value: string;
}

function WizardBody({ wizard, close }: { wizard: WizardState; close(): void }) {
  const t = useT().items.wizard;
  const doc = useApp(selectActiveDoc);
  const [namespace, setNamespace] = useState(wizard.namespace);
  const [itemId, setItemId] = useState(wizard.itemId);
  const [base, setBase] = useState(wizard.base);
  const [mode, setMode] = useState<VariantMode>(wizard.mode);
  const [index, setIndex] = useState(0);
  const [rows, setRows] = useState<Row[]>(wizard.fromModel ? [] : [{ model: '', value: '1' }]);
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    modelCatalog(packContext(doc.filePath)).then(setIds, () => {});
  }, [doc.filePath]);

  const problem = wizard.replace ? null : itemIdProblem(namespace.trim(), itemId.trim());
  const filled = rows.filter((r) => r.model.trim());
  const valid = !problem && base.trim() !== '';

  const create = async () => {
    const variants = filled.map((r, i) => ({ model: r.model.trim(), value: mode === 'range' ? Number(r.value) || i + 1 : r.value.trim() || `variant_${i + 1}` }));
    try {
      if (wizard.replace) {
        await execute('item.apply_variants', { path: '', base: base.trim(), mode, index, variants: variants.length > 0 ? variants : [{ model: base.trim(), value: 1 }] });
        selectNode(doc.id, '');
      } else {
        await execute('document.new_item', {
          namespace: namespace.trim(),
          itemId: itemId.trim(),
          version: wizard.version,
          ...(variants.length > 0 ? { variants: { base: base.trim(), mode, index, variants } } : { model: base.trim() }),
        });
      }
      close();
    } catch (error) {
      notifyError(error);
    }
  };

  const patchRow = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  return (
    <ProjectDialog
      open
      onClose={close}
      title={wizard.replace ? t.replaceTitle : wizard.fromModel ? t.fromModelTitle : t.title}
      width="34rem"
      footer={
        <>
          <button type="button" className={quietButton} onClick={close}>
            {t.cancel}
          </button>
          <button type="button" className={primaryButton} disabled={!valid} onClick={() => void create()}>
            {wizard.replace ? t.apply : t.create}
          </button>
        </>
      }
    >
      <p className="text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">{t.intro}</p>
      {!wizard.replace && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
          <label className="flex flex-col gap-1 text-[calc(12px*var(--font-scale))] text-dim">
            {t.namespace}
            <input className={`${dialogInput} font-mono`} value={namespace} spellCheck={false} onChange={(e) => setNamespace(e.currentTarget.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[calc(12px*var(--font-scale))] text-dim">
            {t.itemId}
            <input className={`${dialogInput} font-mono`} value={itemId} spellCheck={false} autoFocus={!wizard.fromModel} onChange={(e) => setItemId(e.currentTarget.value)} />
          </label>
        </div>
      )}
      {problem && itemId.trim() !== '' && <p className="text-[calc(12px*var(--font-scale))] text-danger">{t.badId}</p>}
      {!wizard.replace && !problem && (
        <p className="font-mono text-[calc(12px*var(--font-scale))] text-faint">
          assets/{namespace.trim()}/items/{itemId.trim()}.json
        </p>
      )}
      <FieldRow title={t.base}>
        <SuggestField label={t.base} value={base} placeholder="minecraft:item/diamond_sword" suggestions={ids} onCommit={setBase} />
      </FieldRow>
      <FieldRow title={t.mode}>
        <Segmented label={t.mode} value={mode} options={variantModes.map((m) => ({ value: m, title: t.modes[m] }))} onChange={(m) => setMode(m as VariantMode)} />
      </FieldRow>
      <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{t.modeHelp[mode]}</p>
      <FieldRow title={t.index}>
        <input type="number" min={0} className={`${dialogInput} h-7`} value={index} onChange={(e) => setIndex(Math.max(0, Math.floor(Number(e.currentTarget.value) || 0)))} />
      </FieldRow>
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_6rem_1.5rem] gap-1.5 text-[calc(12px*var(--font-scale))] text-faint">
          <span>{t.variantModel}</span>
          <span>{mode === 'flags' ? t.flag : t.value}</span>
          <span />
        </div>
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_6rem_1.5rem] items-center gap-1.5">
            <SuggestField label={`${t.variantModel} ${i + 1}`} value={row.model} placeholder="mymod:item/..." suggestions={ids} onCommit={(model) => patchRow(i, { model })} />
            {mode === 'flags' ? (
              <span className="font-mono text-[calc(12px*var(--font-scale))] text-faint">flags[{index + i}]</span>
            ) : (
              <input aria-label={`${t.value} ${i + 1}`} className={`${dialogInput} h-7 font-mono`} value={row.value} onChange={(e) => patchRow(i, { value: e.currentTarget.value })} />
            )}
            <button type="button" className={iconButton} aria-label={t.removeVariant} title={t.removeVariant} onClick={() => setRows((r) => r.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-[calc(12px*var(--font-scale))] text-dim ring-1 ring-line-strong ring-inset hover:text-text"
          onClick={() => setRows((r) => [...r, { model: '', value: mode === 'range' ? String(r.length + 1) : `variant_${r.length + 1}` }])}
        >
          <Plus size={13} /> {t.addVariant}
        </button>
        {/* Always laid out, so that the buttons do not move when the first variant is filled in (a click would miss them). */}
        <p className={`text-[calc(12px*var(--font-scale))] text-faint ${filled.length === 0 ? '' : 'invisible'}`}>{t.noVariants}</p>
      </div>
    </ProjectDialog>
  );
}

/** Mounted once (App); shows the wizard while `useItemUi.wizard` is set. */
export function ItemWizard() {
  const wizard = useItemUi((s) => s.wizard);
  if (!wizard) return null;
  return <WizardBody wizard={wizard} close={() => useItemUi.setState({ wizard: null })} />;
}
