// Editors for the values of an item definition: one per field kind of the registry (core/minecraft/items).
import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { colorToHex, hexToColor } from '../../core/minecraft/items/colors';
import { suggestionLists, type FieldSpec } from '../../core/minecraft/items/registry';
import type { Json } from '../../core/minecraft/items/types';
import { useT } from '../../i18n';
import { PickMenu, Switch } from '../controls';
import { FieldRow, TextField } from '../minecraft/fields';
import { ScrubField } from '../ScrubField';

export const inputClass =
  'h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent';

export const iconButton =
  'flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-text disabled:pointer-events-none disabled:opacity-40';

/** A text field with suggestions (native datalist: filters as you type, accepts any value). Commits on Enter / blur. */
export function SuggestField({
  label,
  value,
  suggestions,
  placeholder,
  mono = true,
  autoFocus,
  onCommit,
}: {
  label: string;
  value: string;
  suggestions: readonly string[];
  placeholder?: string;
  mono?: boolean;
  autoFocus?: boolean;
  onCommit(value: string): void;
}) {
  const listId = useId();
  const reverting = useRef(false);
  return (
    <>
      <input
        key={value}
        aria-label={label}
        defaultValue={value}
        placeholder={placeholder}
        list={suggestions.length > 0 ? listId : undefined}
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        className={`${inputClass} ${mono ? 'font-mono' : ''}`}
        onBlur={(e) => {
          const next = e.currentTarget.value.trim();
          if (reverting.current) e.currentTarget.value = value;
          else if (next !== value) onCommit(next);
          reverting.current = false;
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            reverting.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.slice(0, 5000).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  );
}

/** Colour picker plus the stored number (ARGB int or [r, g, b]); keeps the form the value had. */
export function ColorField({ label, value, onCommit }: { label: string; value: Json | undefined; onCommit(value: Json): void }) {
  const hex = colorToHex(value) ?? '#ffffff';
  const [draft, setDraft] = useState(hex);
  useEffect(() => setDraft(hex), [hex]);
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <input
        type="color"
        aria-label={label}
        value={draft}
        className="h-7 w-9 shrink-0 cursor-pointer rounded-md bg-ink p-0.5 ring-1 ring-line ring-inset"
        onChange={(e) => setDraft(e.currentTarget.value)}
        // The native picker reports every drag step; one undo step per closed picker.
        onBlur={() => draft !== hex && onCommit(hexToColor(draft, value))}
      />
      <TextField
        label={label}
        mono
        value={value === undefined ? '' : JSON.stringify(value)}
        onCommit={(text) => {
          try {
            const parsed = JSON.parse(text) as Json;
            if (colorToHex(parsed)) onCommit(parsed);
          } catch {
            if (/^#?[0-9a-f]{6}$/i.test(text)) onCommit(hexToColor(text.startsWith('#') ? text : `#${text}`, value));
          }
        }}
      />
    </div>
  );
}

/** Any JSON value as text; invalid JSON is not committed and marked. */
export function JsonField({ label, value, rows = 3, onCommit }: { label: string; value: Json | undefined; rows?: number; onCommit(value: Json): void }) {
  const text = value === undefined ? '' : JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
  const [invalid, setInvalid] = useState(false);
  return (
    <textarea
      key={text}
      aria-label={label}
      aria-invalid={invalid}
      defaultValue={text}
      rows={rows}
      spellCheck={false}
      className={`w-full min-w-0 resize-y rounded-md bg-ink px-2 py-1 font-mono text-[calc(12px*var(--font-scale))] text-text ring-1 outline-none ring-inset hover:ring-line-strong focus:ring-accent ${invalid ? 'ring-danger' : 'ring-line'}`}
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (next === text.trim()) return setInvalid(false);
        try {
          onCommit(JSON.parse(next) as Json);
          setInvalid(false);
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}

/** A labelled editor for one field of a property, tint source or special model. `onChange(null)` removes the key. */
export function FieldEditor({ spec, value, onChange }: { spec: FieldSpec; value: Json | undefined; onChange(value: Json | null): void }) {
  const t = useT().items;
  const present = value !== undefined;
  const shown = present ? value : spec.default;
  const reset = present && !spec.required && (
    <button type="button" className={iconButton} title={t.useDefault(JSON.stringify(spec.default ?? null))} aria-label={t.useDefault(JSON.stringify(spec.default ?? null))} onClick={() => onChange(null)}>
      <RotateCcw size={12} />
    </button>
  );
  let control;
  switch (spec.kind) {
    case 'boolean':
      control = <Switch label={spec.key} checked={shown === true} onChange={(checked) => onChange(checked)} />;
      break;
    case 'int':
    case 'float':
      control = (
        <ScrubField
          wide
          label="#"
          ariaLabel={spec.key}
          color="var(--faint)"
          value={typeof shown === 'number' ? shown : 0}
          step={spec.kind === 'int' ? 1 : 0.01}
          integer={spec.kind === 'int'}
          min={spec.min ?? -Infinity}
          onCommit={(v) => onChange(v)}
        />
      );
      break;
    case 'enum':
      control = (
        <PickMenu
          label={spec.key}
          value={typeof shown === 'string' ? shown : null}
          placeholder={typeof shown === 'string' ? shown : t.choose}
          options={(spec.options ?? []).map((o) => ({ value: o, title: o }))}
          onChange={(v) => onChange(v)}
        />
      );
      break;
    case 'string':
    case 'resource':
      control = (
        <SuggestField
          label={spec.key}
          value={typeof value === 'string' ? value : ''}
          placeholder={typeof spec.default === 'string' && spec.default !== '' ? spec.default : undefined}
          suggestions={spec.suggestions ? suggestionLists[spec.suggestions] : []}
          onCommit={(v) => onChange(v === '' && !spec.required ? null : v)}
        />
      );
      break;
    case 'color':
      control = <ColorField label={spec.key} value={shown} onCommit={onChange} />;
      break;
    case 'json':
      control = <JsonField label={spec.key} value={value} onCommit={onChange} />;
      break;
  }
  return (
    <FieldRow title={`${spec.key}${spec.required ? ' *' : ''}`}>
      <div className="flex min-w-0 items-center gap-1">
        <div className={`min-w-0 flex-1 ${present || spec.required ? '' : 'opacity-60'}`}>{control}</div>
        {reset}
      </div>
    </FieldRow>
  );
}

/** Keys Tessel does not know for this spot: shown as JSON, editable, removable. */
export function UnknownFields({ fields, known, onChange }: { fields: Readonly<Record<string, Json>>; known: readonly string[]; onChange(key: string, value: Json | null): void }) {
  const t = useT().items;
  const keys = Object.keys(fields).filter((k) => !known.includes(k));
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-line-strong p-2">
      <p className="text-[calc(11.5px*var(--font-scale))] text-faint">{t.unknownKeys}</p>
      {keys.map((key) => (
        <FieldRow key={key} title={key}>
          <div className="flex min-w-0 items-start gap-1">
            <div className="min-w-0 flex-1">
              <JsonField label={key} value={fields[key]} rows={1} onCommit={(v) => onChange(key, v)} />
            </div>
            <button type="button" className={iconButton} aria-label={t.removeKey(key)} title={t.removeKey(key)} onClick={() => onChange(key, null)}>
              ×
            </button>
          </div>
        </FieldRow>
      ))}
    </div>
  );
}
