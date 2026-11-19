// Right sidebar of item definition documents: the preview's test inputs (top) and the editor of the selected
// node or of the file's root settings (bottom). Every change goes through an item.* command.
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { selectActiveDoc, useApp } from '../../app/store';
import { normalizeId, DISPLAY_CONTEXTS, fieldsIn, findProperty, findSelectProperty, findSpecialModel, findTintSource, itemSpecs, rootFields, shortId, suggestionLists, type PropertyKind } from '../../core/minecraft/items/registry';
import { getNode, walk } from '../../core/minecraft/items/tree';
import type { ItemDocSettings, ItemModelNode, Json, TintSource } from '../../core/minecraft/items/types';
import { nodeToJson } from '../../core/minecraft/items/codec';
import { javaVersions } from '../../core/minecraft/versions';
import type { Doc } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu, Switch } from '../controls';
import { FieldRow, SectionTitle, smallButton, TextField } from '../minecraft/fields';
import { ScrubField } from '../ScrubField';
import { FieldEditor, iconButton, JsonField, SuggestField, UnknownFields } from './fieldEditors';
import { evaluateDoc, selectNode, setInputs, useInputs, useSelectedPath } from './itemStore';
import { nodeTitle, whenText } from './ItemTree';
import { modelCatalog, packContext } from './packAssets';

const panelText = 'text-[calc(12px*var(--font-scale))]';

/** Model ids of the pack and vanilla for autocompletion (loaded once per pack). */
function useModelIds(doc: Doc): string[] {
  const [ids, setIds] = useState<string[]>([]);
  const filePath = doc.filePath;
  useEffect(() => {
    let live = true;
    modelCatalog(packContext(filePath)).then((list) => live && setIds(list), () => {});
    return () => {
      live = false;
    };
  }, [filePath]);
  return ids;
}

function ModelField({ doc, label, value, onCommit }: { doc: Doc; label: string; value: string; onCommit(value: string): void }) {
  const ids = useModelIds(doc);
  const t = useT().items;
  return <SuggestField label={label} value={value} placeholder={t.modelPlaceholder} suggestions={ids} onCommit={onCommit} />;
}

// ---- test inputs ---------------------------------------------------------------------------------

const parseList = <T,>(text: string, parse: (s: string) => T | undefined): T[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(parse)
    .filter((v): v is T => v !== undefined);

/** The properties the definition uses, beyond those the fixed inputs cover. */
function usedProperties(item: ItemDocSettings) {
  const conditions = new Map<string, string>();
  const selects = new Map<string, Set<string>>();
  const numbers = new Set<string>();
  for (const { node } of walk(item.definition)) {
    if (node.kind === 'condition') {
      const id = normalizeId(node.property);
      if (['minecraft:custom_model_data', 'minecraft:damaged', 'minecraft:broken'].includes(id)) continue;
      const key = id === 'minecraft:keybind_down' ? `${id}/${String(node.fields.keybind ?? '')}` : id;
      conditions.set(key, id === 'minecraft:keybind_down' ? `keybind_down ${String(node.fields.keybind ?? '')}` : shortId(id));
    } else if (node.kind === 'select') {
      const id = normalizeId(node.property);
      if (id === 'minecraft:custom_model_data' || id === 'minecraft:display_context') continue;
      const values = selects.get(id) ?? new Set<string>();
      for (const c of node.cases) for (const v of Array.isArray(c.when) ? (c.when as Json[]) : [c.when]) if (typeof v === 'string') values.add(v);
      for (const o of findSelectProperty(id, item.version)?.values.options ?? []) values.add(o);
      selects.set(id, values);
    } else if (node.kind === 'range_dispatch') {
      const id = normalizeId(node.property);
      if (!['minecraft:custom_model_data', 'minecraft:damage', 'minecraft:count'].includes(id)) numbers.add(id);
    }
  }
  return { conditions, selects, numbers };
}

export function TestInputs() {
  const doc = useApp(selectActiveDoc);
  const t = useT().items;
  const inputs = useInputs(doc.id);
  const item = doc.state.item;
  const used = useMemo(() => (item ? usedProperties(item) : null), [item]);
  const evaluation = useMemo(() => evaluateDoc(doc, inputs), [doc, inputs]);
  if (!item || !used || !evaluation) return null;
  const set = (patch: Partial<typeof inputs>) => setInputs(doc.id, (i) => ({ ...i, ...patch }));
  const cmd = inputs.customModelData ?? {};
  const setCmd = (patch: Partial<NonNullable<typeof inputs.customModelData>>) => set({ customModelData: { ...cmd, ...patch } });
  const num = (label: string, value: number, onCommit: (v: number) => void, integer = true) => (
    <ScrubField wide label="#" ariaLabel={label} color="var(--faint)" value={value} step={integer ? 1 : 0.01} integer={integer} onCommit={onCommit} />
  );
  return (
    <section aria-label={t.inputs.title} className="min-h-0 overflow-y-auto border-b border-line px-3 py-2.5">
      <h2 className={`mb-2 font-semibold text-text ${panelText}`}>{t.inputs.title}</h2>
      <div className="flex flex-col gap-2">
        <FieldRow title={t.inputs.displayContext}>
          <PickMenu
            label={t.inputs.displayContext}
            value={inputs.displayContext ?? 'gui'}
            placeholder="gui"
            options={DISPLAY_CONTEXTS.map((c) => ({ value: c, title: c }))}
            onChange={(displayContext) => set({ displayContext })}
          />
        </FieldRow>
        <FieldRow title={t.inputs.floats}>
          <TextField label={t.inputs.floats} mono placeholder="1, 2.5" value={(cmd.floats ?? []).join(', ')} onCommit={(v) => setCmd({ floats: parseList(v, (s) => (Number.isFinite(Number(s)) ? Number(s) : undefined)) })} />
        </FieldRow>
        <FieldRow title={t.inputs.flags}>
          <TextField label={t.inputs.flags} mono placeholder="true, false" value={(cmd.flags ?? []).join(', ')} onCommit={(v) => setCmd({ flags: parseList(v, (s) => (s === 'true' || s === '1' ? true : s === 'false' || s === '0' ? false : undefined)) })} />
        </FieldRow>
        <FieldRow title={t.inputs.strings}>
          <TextField label={t.inputs.strings} mono placeholder="flame, frost" value={(cmd.strings ?? []).join(', ')} onCommit={(v) => setCmd({ strings: parseList(v, (s) => s) })} />
        </FieldRow>
        <FieldRow title={t.inputs.colors}>
          <TextField
            label={t.inputs.colors}
            mono
            placeholder="#ff0000"
            value={(cmd.colors ?? []).map((c) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`).join(', ')}
            onCommit={(v) => setCmd({ colors: parseList(v, (s) => (/^#?[0-9a-f]{6}$/i.test(s) ? parseInt(s.replace('#', ''), 16) : undefined)) })}
          />
        </FieldRow>
        <FieldRow title={t.inputs.damage}>
          <div className="grid grid-cols-2 gap-1">
            {num(t.inputs.damage, inputs.damage ?? 0, (damage) => set({ damage: Math.max(0, damage) }))}
            {num(t.inputs.maxDamage, inputs.maxDamage ?? 0, (maxDamage) => set({ maxDamage: Math.max(0, maxDamage) }))}
          </div>
        </FieldRow>
        <FieldRow title={t.inputs.count}>
          <div className="grid grid-cols-2 gap-1">
            {num(t.inputs.count, inputs.count ?? 1, (count) => set({ count: Math.max(0, count) }))}
            {num(t.inputs.maxStack, inputs.maxStackSize ?? 64, (maxStackSize) => set({ maxStackSize: Math.max(1, maxStackSize) }))}
          </div>
        </FieldRow>
        {[...used.conditions].map(([key, title]) => (
          <FieldRow key={key} title={title}>
            <Switch label={title} checked={inputs.conditions?.[key] ?? false} onChange={(v) => set({ conditions: { ...inputs.conditions, [key]: v } })} />
          </FieldRow>
        ))}
        {[...used.selects].map(([id, values]) => (
          <FieldRow key={id} title={shortId(id)}>
            <PickMenu
              label={shortId(id)}
              value={typeof inputs.selects?.[id] === 'string' ? (inputs.selects[id] as string) : null}
              placeholder={t.inputs.noValue}
              options={[{ value: '', title: t.inputs.noValue }, ...[...values].map((v) => ({ value: v, title: v }))]}
              onChange={(v) => {
                const selects = { ...inputs.selects };
                if (v === '') delete selects[id];
                else selects[id] = v;
                set({ selects });
              }}
            />
          </FieldRow>
        ))}
        {[...used.numbers].map((id) => (
          <FieldRow key={id} title={shortId(id)}>
            {num(shortId(id), inputs.numbers?.[id] ?? 0, (v) => set({ numbers: { ...inputs.numbers, [id]: v } }), false)}
          </FieldRow>
        ))}
      </div>
      <h3 className={`mt-3 mb-1 font-semibold text-dim ${panelText}`}>{t.inputs.result}</h3>
      <ul className="flex flex-col gap-0.5">
        {evaluation.rendered.map((r) => (
          <li key={r.path}>
            <button type="button" className={`w-full truncate rounded px-1.5 py-0.5 text-left font-mono hover:bg-raised ${panelText} ${r.model ? 'text-text' : 'text-danger'}`} onClick={() => selectNode(doc.id, r.path)}>
              {r.kind === 'model' ? shortId(r.model) || t.noModel : r.kind === 'special' ? `${t.kinds.special}: ${shortId(r.special ?? '')}` : r.kind === 'unknown' ? t.missingModel : t.kinds[r.kind]}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- inspector -----------------------------------------------------------------------------------

function FileSettings({ item }: { item: ItemDocSettings }) {
  const t = useT().items;
  const fields = item.definition.fields;
  const keyParam: Record<string, string> = { hand_animation_on_swap: 'handAnimationOnSwap', oversized_in_gui: 'oversizedInGui', swap_animation_scale: 'swapAnimationScale' };
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow title={t.namespace}>
        <TextField label={t.namespace} mono value={item.namespace} onCommit={(namespace) => namespace && void dispatch('item.set_settings', { namespace })} />
      </FieldRow>
      <FieldRow title={t.itemId}>
        <TextField label={t.itemId} mono value={item.id} onCommit={(itemId) => itemId && void dispatch('item.set_settings', { itemId })} />
      </FieldRow>
      <FieldRow title={t.version}>
        <PickMenu label={t.version} value={item.version} placeholder={item.version} options={javaVersions.map((v) => ({ value: v.id, title: v.label }))} onChange={(version) => void dispatch('item.set_settings', { version })} />
      </FieldRow>
      <p className={`font-mono text-faint ${panelText}`}>
        assets/{item.namespace}/items/{item.id}.json
      </p>
      <SectionTitle>{t.rootOptions}</SectionTitle>
      {fieldsIn(rootFields, item.version).map((spec) => (
        <FieldEditor key={spec.key} spec={spec} value={fields[spec.key]} onChange={(value) => void dispatch('item.set_settings', { [keyParam[spec.key]]: value })} />
      ))}
      <p className={`leading-snug text-faint ${panelText}`}>{t.rootHint}</p>
    </div>
  );
}

/** The `when` of a select case: toggles for fixed values, text for free ones, JSON for component values. */
function WhenEditor({ parentPath, parent, index, version }: { parentPath: string; parent: ItemModelNode & { kind: 'select' }; index: number; version: string }) {
  const t = useT().items;
  const when = parent.cases[index].when;
  const values = findSelectProperty(parent.property, version)?.values;
  const commit = (next: Json) => void dispatch('item.update_child', { path: parentPath, index, when: next });
  const list = (Array.isArray(when) ? (when as Json[]) : [when]).filter((v): v is string => typeof v === 'string');
  const asWhen = (items: string[]): Json => (items.length === 1 ? items[0] : items);
  if (values?.kind === 'json' || !values) return <JsonField label={t.when} value={when} onCommit={commit} />;
  if (values.kind === 'enum') {
    return (
      <div className="flex flex-wrap gap-1" role="group" aria-label={t.when}>
        {(values.options ?? []).map((option) => {
          const on = list.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              className={`rounded-md px-1.5 py-0.5 font-mono ${panelText} ring-1 ring-inset ${on ? 'bg-accent/15 text-accent ring-accent/50' : 'text-dim ring-line hover:text-text'}`}
              onClick={() => {
                const next = on ? list.filter((v) => v !== option) : [...list, option];
                if (next.length > 0) commit(asWhen(next));
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <SuggestField
      label={t.when}
      value={whenText(when)}
      placeholder={t.whenHint}
      suggestions={values.suggestions ? suggestionLists[values.suggestions] : []}
      onCommit={(text) => {
        const items = text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length > 0) commit(asWhen(items));
      }}
    />
  );
}

function TintsEditor({ path, tints, version }: { path: string; tints: readonly TintSource[]; version: string }) {
  const t = useT().items;
  const specs = itemSpecs(version).tintSources;
  return (
    <div className="flex flex-col gap-2">
      {tints.map((tint, index) => {
        const spec = findTintSource(tint.type, version);
        return (
          <div key={index} className="flex flex-col gap-1.5 rounded-md border border-line p-2">
            <div className="flex items-center gap-1">
              <span className={`shrink-0 font-mono text-faint ${panelText}`} title={t.tintIndexHint}>
                {index}
              </span>
              <div className="min-w-0 flex-1">
                <PickMenu
                  label={t.tintType}
                  value={spec?.id ?? null}
                  placeholder={tint.type}
                  options={specs.map((s) => ({ value: s.id, title: shortId(s.id) }))}
                  onChange={(type) => void dispatch('item.update_tint', { path, index, type })}
                />
              </div>
              <button type="button" className={iconButton} disabled={index === 0} aria-label={t.moveUp} title={t.moveUp} onClick={() => void dispatch('item.move_tint', { path, from: index, to: index - 1 })}>
                <ArrowUp size={12} />
              </button>
              <button type="button" className={iconButton} disabled={index === tints.length - 1} aria-label={t.moveDown} title={t.moveDown} onClick={() => void dispatch('item.move_tint', { path, from: index, to: index + 1 })}>
                <ArrowDown size={12} />
              </button>
              <button type="button" className={iconButton} aria-label={t.removeTint} title={t.removeTint} onClick={() => void dispatch('item.remove_tint', { path, index })}>
                <Trash2 size={12} />
              </button>
            </div>
            {spec &&
              fieldsIn(spec.fields, version).map((field) => (
                <FieldEditor key={field.key} spec={field} value={tint.fields[field.key]} onChange={(value) => void dispatch('item.update_tint', { path, index, fields: { [field.key]: value } })} />
              ))}
            <UnknownFields fields={tint.fields} known={spec?.fields.map((f) => f.key) ?? []} onChange={(key, value) => void dispatch('item.update_tint', { path, index, fields: { [key]: value } })} />
          </div>
        );
      })}
      <PickMenu
        label={t.addTint}
        value={null}
        placeholder={`+ ${t.addTint}`}
        options={specs.map((s) => ({ value: s.id, title: shortId(s.id) }))}
        onChange={(type) => void dispatch('item.add_tint', { path, type })}
      />
    </div>
  );
}

function PropertyEditor({ path, node, version }: { path: string; node: ItemModelNode & { kind: PropertyKind }; version: string }) {
  const t = useT().items;
  const specs = node.kind === 'condition' ? itemSpecs(version).conditionProperties : node.kind === 'select' ? itemSpecs(version).selectProperties : itemSpecs(version).rangeProperties;
  const spec = findProperty(node.kind, node.property, version);
  return (
    <>
      <FieldRow title={t.property}>
        <PickMenu label={t.property} value={spec?.id ?? null} placeholder={node.property} options={specs.map((s) => ({ value: s.id, title: shortId(s.id) }))} onChange={(property) => void dispatch('item.update_node', { path, property })} />
      </FieldRow>
      <p className={`leading-snug text-faint ${panelText}`}>{t.propertyHelp[node.kind]}</p>
      {spec && fieldsIn(spec.fields, version).map((field) => <FieldEditor key={field.key} spec={field} value={node.fields[field.key]} onChange={(value) => void dispatch('item.update_node', { path, fields: { [field.key]: value } })} />)}
      <UnknownFields fields={node.fields} known={spec?.fields.map((f) => f.key) ?? []} onChange={(key, value) => void dispatch('item.update_node', { path, fields: { [key]: value } })} />
    </>
  );
}

function NodeEditor({ doc, item, path }: { doc: Doc; item: ItemDocSettings; path: string }) {
  const t = useT().items;
  let node: ItemModelNode;
  try {
    node = getNode(item.definition, path);
  } catch {
    return <p className={`text-faint ${panelText}`}>{t.nothingSelected}</p>;
  }
  const version = item.version;
  const match = /^(.*?)\/?(cases|entries|models)\/(\d+)$/.exec(path);
  const parentPath = match ? match[1] : null;
  const parent = parentPath !== null ? getNode(item.definition, parentPath) : null;
  const index = match ? Number(match[3]) : -1;
  const types = itemSpecs(version).modelTypes;
  return (
    <div className="flex flex-col gap-2.5">
      {parent?.kind === 'select' && (
        // Full width: the fixed values (display contexts ...) are long.
        <div className="flex flex-col gap-1">
          <span className={`text-dim ${panelText}`}>{t.when}</span>
          <WhenEditor parentPath={parentPath!} parent={parent} index={index} version={version} />
        </div>
      )}
      {parent?.kind === 'range_dispatch' && (
        <FieldRow title={t.threshold}>
          <ScrubField wide label="≥" ariaLabel={t.threshold} color="var(--faint)" value={parent.entries[index].threshold} step={0.01} onCommit={(threshold) => void dispatch('item.update_child', { path: parentPath, index, threshold })} />
        </FieldRow>
      )}
      <FieldRow title={t.type}>
        <PickMenu label={t.type} value={types.find((x) => x.id === normalizeId(node.type))?.id ?? null} placeholder={node.type} options={types.map((x) => ({ value: x.id, title: t.kinds[x.kind] }))} onChange={(type) => void dispatch('item.set_type', { path, type })} />
      </FieldRow>
      <p className={`leading-snug text-faint ${panelText}`}>{t.typeHelp[node.kind]}</p>

      {node.kind === 'model' && (
        <>
          <FieldRow title={t.model}>
            <ModelField doc={doc} label={t.model} value={node.model} onCommit={(model) => void dispatch('item.update_node', { path, model })} />
          </FieldRow>
          <SectionTitle>{t.tints}</SectionTitle>
          <TintsEditor path={path} tints={node.tints ?? []} version={version} />
        </>
      )}
      {(node.kind === 'condition' || node.kind === 'select' || node.kind === 'range_dispatch') && <PropertyEditor path={path} node={node} version={version} />}
      {node.kind === 'range_dispatch' && (
        <FieldRow title={t.scale}>
          <ScrubField wide label="×" ariaLabel={t.scale} color="var(--faint)" value={node.scale ?? 1} step={0.01} onCommit={(scale) => void dispatch('item.update_node', { path, scale })} />
        </FieldRow>
      )}
      {(node.kind === 'select' || node.kind === 'range_dispatch' || node.kind === 'composite') && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" className={smallButton} onClick={() => void dispatch('item.add_child', { path }).then((r) => r && selectNode(doc.id, (r as { path: string }).path))}>
            <Plus size={13} /> {t.addPart[node.kind]}
          </button>
          {node.kind !== 'composite' && (
            <button type="button" className={smallButton} onClick={() => void dispatch('item.set_fallback', { path, remove: !!node.fallback })}>
              {node.fallback ? t.removeFallback : t.addFallback}
            </button>
          )}
        </div>
      )}
      {node.kind === 'special' && (
        <>
          <FieldRow title={t.base}>
            <ModelField doc={doc} label={t.base} value={node.base} onCommit={(base) => void dispatch('item.update_node', { path, base })} />
          </FieldRow>
          <FieldRow title={t.specialType}>
            <PickMenu
              label={t.specialType}
              value={findSpecialModel(node.special.type, version)?.id ?? null}
              placeholder={node.special.type}
              options={itemSpecs(version).specialModels.map((s) => ({ value: s.id, title: shortId(s.id) }))}
              onChange={(specialType) => void dispatch('item.update_node', { path, specialType })}
            />
          </FieldRow>
          {fieldsIn(findSpecialModel(node.special.type, version)?.fields ?? [], version).map((field) => (
            <FieldEditor key={field.key} spec={field} value={node.special.fields[field.key]} onChange={(value) => void dispatch('item.update_node', { path, specialFields: { [field.key]: value } })} />
          ))}
          <UnknownFields
            fields={node.special.fields}
            known={findSpecialModel(node.special.type, version)?.fields.map((f) => f.key) ?? []}
            onChange={(key, value) => void dispatch('item.update_node', { path, specialFields: { [key]: value } })}
          />
        </>
      )}
      {node.kind !== 'unknown' && node.kind !== 'condition' && node.kind !== 'select' && node.kind !== 'range_dispatch' && (
        <UnknownFields fields={node.fields} known={[]} onChange={(key, value) => void dispatch('item.update_node', { path, fields: { [key]: value } })} />
      )}

      <details className="group">
        <summary className={`cursor-default text-dim hover:text-text ${panelText}`}>{t.transformation}</summary>
        <div className="mt-1.5 flex flex-col gap-1.5">
          <p className={`leading-snug text-faint ${panelText}`}>{t.transformationHint}</p>
          <JsonField label={t.transformation} value={node.transformation} rows={3} onCommit={(transformation) => void dispatch('item.update_node', { path, transformation })} />
          {node.transformation !== undefined && (
            <button type="button" className={smallButton} onClick={() => void dispatch('item.update_node', { path, transformation: null })}>
              {t.removeTransformation}
            </button>
          )}
        </div>
      </details>
      <details open={node.kind === 'unknown'}>
        <summary className={`cursor-default text-dim hover:text-text ${panelText}`}>{t.nodeJson}</summary>
        <div className="mt-1.5">
          <JsonField label={t.nodeJson} value={nodeToJson(node)} rows={8} onCommit={(json) => void dispatch('item.set_node', { path, json })} />
        </div>
      </details>
    </div>
  );
}

export function ItemInspector() {
  const doc = useApp(selectActiveDoc);
  const t = useT().items;
  const path = useSelectedPath(doc.id);
  const item = doc.state.item;
  if (!item) return null;
  let title = t.fileSettings;
  if (path !== null) {
    try {
      title = nodeTitle(getNode(item.definition, path), t);
    } catch {
      title = t.nothingSelected;
    }
  }
  return (
    // Keyed by the node, so that every selection starts at the top.
    <section key={`${doc.id}:${path ?? ''}`} aria-label={t.inspector} className="min-h-0 overflow-y-auto px-3 py-2.5">
      <h2 className={`mb-0.5 truncate font-semibold text-text ${panelText}`} title={title}>
        {title}
      </h2>
      <p className={`mb-2 truncate font-mono text-faint ${panelText}`}>{path === null ? t.file : path || t.root}</p>
      {path === null ? <FileSettings item={item} /> : <NodeEditor doc={doc} item={item} path={path} />}
    </section>
  );
}
