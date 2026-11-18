import { useMemo } from 'react';
import { z } from 'zod';
import { commandsById } from '../core/commands';
import { PickMenu, Switch } from './controls';
import { tweakOp, useLastOp } from './live';
import { ScrubField } from './ScrubField';

/** German names of command parameters. Unknown parameters show their own name. */
const paramLabels: Record<string, string> = {
  distance: 'Abstand',
  thickness: 'Stärke',
  depth: 'Tiefe',
  individual: 'Einzeln',
  width: 'Breite',
  segments: 'Segmente',
  cuts: 'Schnitte',
  at: 'Ziel',
  kind: 'Elemente',
  size: 'Größe',
  radius: 'Radius',
  height: 'Höhe',
  rings: 'Ringe',
  subdivisions: 'Unterteilungen',
  minorRadius: 'Rohrradius',
  minorSegments: 'Rohrsegmente',
  position: 'Position',
  rotation: 'Drehung',
  scale: 'Skalierung',
  translate: 'Verschiebung',
  rotate: 'Drehung',
  pivot: 'Drehpunkt',
  count: 'Anzahl',
  offset: 'Versatz',
  levels: 'Stufen',
  angle: 'Winkel',
  smooth: 'Glätten',
};

const valueLabels: Record<string, string> = {
  center: 'Mitte',
  first: 'Erster',
  last: 'Letzter',
  vertices: 'Eckpunkte',
  edges: 'Kanten',
  faces: 'Flächen',
};

/** Parameters a command shows in the panel when not all of them make sense. */
const shown: Record<string, (params: Record<string, unknown>) => readonly string[]> = {
  'scene.add_primitive': (params) => [
    ...({
      cube: ['size'],
      plane: ['size'],
      uv_sphere: ['radius', 'segments', 'rings'],
      ico_sphere: ['radius', 'subdivisions'],
      cylinder: ['radius', 'height', 'segments'],
      cone: ['radius', 'height', 'segments'],
      torus: ['radius', 'minorRadius', 'segments', 'minorSegments'],
    }[params.type as string] ?? []),
    'position',
  ],
};

type Field =
  | { kind: 'number'; key: string; fallback?: number; integer: boolean; min?: number; max?: number }
  | { kind: 'boolean'; key: string; fallback?: boolean }
  | { kind: 'enum'; key: string; fallback?: string; options: string[] }
  | { kind: 'vec3'; key: string; fallback?: number[] };

interface JsonProp {
  type?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
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

const rowLabel = 'min-w-0 flex-1 truncate text-[12px] text-dim';

/**
 * Parameters of the operation that just ran. Changing one re-runs the operation in place of its
 * previous run (see `live.ts`), which replaces mouse-driven modal tools.
 */
export function LastOpPanel() {
  const op = useLastOp((s) => s.op);
  const fields = useMemo(() => (op ? fieldsOf(op.commandId) : []), [op?.commandId]);
  if (!op) return null;

  const only = shown[op.commandId]?.(op.params);
  const offered = only ? only.flatMap((key) => fields.filter((f) => f.key === key)) : fields;
  const visible = offered.filter(
    // A number or vector needs a value to start from.
    (f) => f.kind === 'enum' || (op.params[f.key] ?? f.fallback) !== undefined,
  );
  const title = op.title ?? commandsById.get(op.commandId)?.title ?? op.commandId;
  const set = (key: string, value: unknown) => tweakOp({ ...op.params, [key]: value });

  return (
    <section
      aria-label="Letzte Aktion"
      className="anim-pop absolute bottom-3 left-3 flex max-h-[calc(100%-4.5rem)] w-56 flex-col rounded-lg border border-line-strong bg-overlay/95 shadow-pop backdrop-blur-sm"
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 pr-2.5 pl-3">
        <h2 className="min-w-0 truncate text-[12.5px] font-semibold text-text">{title}</h2>
        <span className="shrink-0 text-[11.5px] text-faint">Letzte Aktion</span>
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
            if (field.kind === 'enum') {
              return (
                <div key={field.key} className="flex h-7 items-center gap-2 pl-2">
                  <span className={rowLabel}>{label}</span>
                  <div className="w-28 shrink-0">
                    <PickMenu
                      label={label}
                      value={(value as string | undefined) ?? null}
                      placeholder="Standard"
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
                <div className="pt-0.5 pb-1 pl-2 text-[12px] text-dim">{label}</div>
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
