import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { commandsById } from '../core/commands';
import { commandTitle, useT } from '../i18n';
import { PickMenu, Switch } from './controls';
import { BUILTIN_FONT, FontPicker } from './FontPicker';
import { tweakOp, useLastOp } from './live';
import { ScrubField } from './ScrubField';

/** Parameters a command shows in the panel when not all of them make sense. */
const shown: Record<string, (params: Record<string, unknown>) => readonly string[]> = {
  'scene.add_primitive': (params) => [
    ...({
      cube: ['size', 'dimensions'],
      plane: ['size'],
      uv_sphere: ['radius', 'segments', 'rings'],
      ico_sphere: ['radius', 'subdivisions'],
      cylinder: ['radius', 'height', 'segments'],
      cone: ['radius', 'height', 'segments'],
      torus: ['radius', 'minorRadius', 'segments', 'minorSegments'],
      arc: ['innerRadius', 'outerRadius', 'height', 'angle', 'startAngle', 'segments'],
    }[params.type as string] ?? []),
    'position',
  ],
  // Bold and italic are styles of an installed font; the built-in one has neither.
  'scene.add_text': (params) => [
    'text',
    'font',
    ...(String(params.font ?? BUILTIN_FONT).trim().toLowerCase() === BUILTIN_FONT ? [] : ['bold', 'italic']),
    'size',
    'depth',
    'align',
    'position',
  ],
  'uv.unwrap': (params) => ['method', ...({ smart: ['angle', 'margin'], box: ['margin'] }[params.method as string] ?? ['axis'])],
  'uv.pack': () => ['margin'],
  'uv.transform': () => ['rotate'],
};

type Field =
  | { kind: 'number'; key: string; fallback?: number; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean'; key: string; fallback?: boolean }
  | { kind: 'enum'; key: string; fallback?: string; options: string[] }
  | { kind: 'font'; key: string; fallback?: string }
  | { kind: 'text'; key: string; fallback?: string; maxLength?: number }
  | { kind: 'vec3'; key: string; fallback?: number[] };

interface JsonProp {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  maxLength?: number;
  prefixItems?: { type?: string }[];
}

/** The fields the panel can render for a command, from its parameter schema. Everything else is skipped. */
function fieldsOf(commandId: string): Field[] {
  const def = commandsById.get(commandId);
  if (!def) return [];
  let props: Record<string, JsonProp>;
  try {
    props = (z.toJSONSchema(def.params, { io: 'input' }) as { properties?: Record<string, JsonProp> }).properties ?? {};
  } catch {
    return [];
  }
  const fields: Field[] = [];
  for (const [key, p] of Object.entries(props)) {
    if (p.type === 'number' || p.type === 'integer') {
      // Three decimals are shown, so that is the smallest value above an exclusive bound.
      const min = p.minimum ?? (p.exclusiveMinimum !== undefined ? p.exclusiveMinimum + 0.001 : undefined);
      fields.push({ kind: 'number', key, fallback: p.default as number | undefined, integer: p.type === 'integer', min, max: p.maximum });
    } else if (p.type === 'boolean') {
      fields.push({ kind: 'boolean', key, fallback: p.default as boolean | undefined });
    } else if (p.type === 'string' && p.enum?.every((v) => typeof v === 'string')) {
      fields.push({ kind: 'enum', key, fallback: p.default as string | undefined, options: p.enum as string[] });
    } else if (p.type === 'string' && key === 'font') {
      fields.push({ kind: 'font', key, fallback: p.default as string | undefined });
    } else if (p.type === 'string') {
      // Free text (enums and the font have their own controls above).
      fields.push({ kind: 'text', key, fallback: p.default as string | undefined, maxLength: p.maxLength });
    } else if (p.type === 'array' && p.prefixItems?.length === 3 && p.prefixItems.every((i) => i.type === 'number')) {
      fields.push({ kind: 'vec3', key, fallback: p.default as number[] | undefined });
    }
  }
  return fields;
}

const axes = [
  { label: 'X', color: 'var(--axis-x)' },
  { label: 'Y', color: 'var(--axis-y)' },
  { label: 'Z', color: 'var(--axis-z)' },
] as const;

const rowLabel = 'min-w-0 flex-1 truncate text-[calc(12px*var(--font-scale))] text-dim';

/** String parameters that take several lines, by command. */
const multiline: Record<string, readonly string[]> = { 'scene.add_text': ['text'] };

/**
 * A string parameter. The operation is re-run when the field is left or with Ctrl+Enter (Enter alone
 * in a single-line field), not on every keystroke: half-typed text would run the operation each time.
 * Escape puts the committed text back.
 */
function TextParam({ label, value, lines, maxLength, onCommit }: { label: string; value: string; lines: boolean; maxLength?: number; onCommit(value: string): void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    // An empty text is not a value the operation takes; the field falls back to what it had.
    if (draft === '') setDraft(value);
    else if (draft !== value) onCommit(draft);
  };
  const shared = {
    'aria-label': label,
    value: draft,
    maxLength,
    spellCheck: false,
    autoComplete: 'off',
    onBlur: commit,
    className:
      'w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset select-text hover:ring-line-strong focus:ring-accent',
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey || !lines)) {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setDraft(value);
    }
  };
  return (
    <label className="flex flex-col gap-1">
      <span className="pt-0.5 pl-2 text-[calc(12px*var(--font-scale))] text-dim">{label}</span>
      {lines ? (
        <textarea {...shared} rows={Math.min(5, Math.max(2, draft.split('\n').length))} className={`${shared.className} resize-none py-1 leading-snug`} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />
      ) : (
        <input {...shared} className={`${shared.className} h-7`} onChange={(event) => setDraft(event.currentTarget.value)} onKeyDown={onKeyDown} />
      )}
    </label>
  );
}

/**
 * Parameters of the operation that just ran. Changing one re-runs the operation in place of its
 * previous run (see `live.ts`), which replaces mouse-driven modal tools.
 */
export function LastOpPanel() {
  const op = useLastOp((s) => s.op);
  const t = useT();
  const fields = useMemo(() => (op ? fieldsOf(op.commandId) : []), [op?.commandId]);
  if (!op) return null;

  const only = shown[op.commandId]?.(op.params);
  const offered = only ? only.flatMap((key) => fields.filter((f) => f.key === key)) : fields;
  const visible = offered.filter(
    // A number or vector needs a value to start from.
    (f) => f.kind === 'enum' || f.kind === 'font' || f.kind === 'text' || (op.params[f.key] ?? f.fallback) !== undefined,
  );
  const def = commandsById.get(op.commandId);
  const title = op.title?.(t) ?? (def ? commandTitle(def) : op.commandId);
  // Unknown parameters and values show their own name.
  const paramLabels: Record<string, string> = t.lastAction.params;
  const valueLabels: Record<string, string> = t.lastAction.values;
  const set = (key: string, value: unknown) => tweakOp({ ...op.params, [key]: value });

  return (
    <section
      aria-label={t.lastAction.title}
      className="anim-pop absolute bottom-3 left-3 flex max-h-[calc(100%-4.5rem)] w-56 max-w-[calc(100%-1.5rem)] flex-col rounded-lg border border-line-strong bg-overlay/95 shadow-pop backdrop-blur-sm"
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 pr-2.5 pl-3">
        <h2 className="min-w-0 truncate text-[calc(12.5px*var(--font-scale))] font-semibold text-text">{title}</h2>
        <span className="shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{t.lastAction.title}</span>
      </header>
      {visible.length > 0 && (
        <div className="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2">
          {visible.map((field) => {
            const label = paramLabels[field.key] ?? field.key;
            const value = op.params[field.key] ?? field.fallback;
            if (field.kind === 'number') {
              return (
                <ScrubField
                  key={field.key}
                  wide
                  label={label}
                  ariaLabel={label}
                  color="var(--dim)"
                  value={value as number}
                  step={field.integer ? 0.1 : 0.01}
                  integer={field.integer}
                  min={field.min}
                  max={field.max}
                  onCommit={(v) => set(field.key, v)}
                  onScrub={(v) => set(field.key, v)}
                />
              );
            }
            if (field.kind === 'boolean') {
              return (
                <div key={field.key} className="flex h-7 items-center gap-2 pr-1.5 pl-2">
                  <span className={rowLabel}>{label}</span>
                  <Switch label={label} checked={value as boolean} onChange={(v) => set(field.key, v)} />
                </div>
              );
            }
            if (field.kind === 'text') {
              return (
                <TextParam
                  key={field.key}
                  label={label}
                  value={(value as string | undefined) ?? ''}
                  lines={multiline[op.commandId]?.includes(field.key) ?? false}
                  maxLength={field.maxLength}
                  onCommit={(v) => set(field.key, v)}
                />
              );
            }
            if (field.kind === 'font') {
              return (
                <div key={field.key} className="flex h-7 items-center gap-2 pl-2">
                  <span className={rowLabel}>{label}</span>
                  <div className="w-36 shrink-0">
                    <FontPicker label={label} value={(value as string | undefined) ?? BUILTIN_FONT} onChange={(v) => set(field.key, v)} />
                  </div>
                </div>
              );
            }
            if (field.kind === 'enum') {
              return (
                <div key={field.key} className="flex h-7 items-center gap-2 pl-2">
                  <span className={rowLabel}>{label}</span>
                  <div className="w-28 shrink-0">
                    <PickMenu
                      label={label}
                      value={(value as string | undefined) ?? null}
                      placeholder={t.lastAction.defaultValue}
                      options={field.options.map((o) => ({ value: o, title: valueLabels[o] ?? o }))}
                      onChange={(v) => set(field.key, v)}
                    />
                  </div>
                </div>
              );
            }
            const vec = value as number[];
            return (
              <div key={field.key} role="group" aria-label={label}>
                <div className="pt-0.5 pb-1 pl-2 text-[calc(12px*var(--font-scale))] text-dim">{label}</div>
                <div className="grid grid-cols-3 gap-1">
                  {axes.map((axis, i) => {
                    const change = (v: number) => set(field.key, vec.map((old, j) => (j === i ? v : old)));
                    return (
                      <ScrubField
                        key={axis.label}
                        label={axis.label}
                        ariaLabel={`${label} ${axis.label}`}
                        color={axis.color}
                        value={vec[i]}
                        step={0.01}
                        onCommit={change}
                        onScrub={change}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
