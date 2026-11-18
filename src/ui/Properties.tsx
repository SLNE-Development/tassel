import { useMemo, useRef } from 'react';
import { selectDocState, useApp } from '../app/store';
import { meshStats } from '../core/mesh/polymesh';
import { evaluateObject } from '../core/modifiers/evaluate';
import type { PolyMesh, Transform, Vec3 } from '../core/types';
import { useT } from '../i18n';
import { dispatch, shortcutLabel } from './actions';
import { Switch } from './controls';
import { useLiveEdit } from './live';
import { Materials } from './Materials';
import { Modifiers } from './Modifiers';
import { ScrubField } from './ScrubField';
import { elementCounts } from './StatusBar';

const axes = [
  { label: 'X', color: 'var(--axis-x)' },
  { label: 'Y', color: 'var(--axis-y)' },
  { label: 'Z', color: 'var(--axis-z)' },
] as const;

const rows: { key: keyof Transform; unit: string; step: number }[] = [
  { key: 'position', unit: 'm', step: 0.01 },
  { key: 'rotation', unit: '°', step: 0.5 },
  { key: 'scale', unit: '×', step: 0.01 },
];

function NameField({ id, name }: { id: string; name: string }) {
  const reverting = useRef(false);
  const t = useT();
  return (
    <input
      // Remount when the name changes from outside (undo, MCP), so the field never shows a stale value.
      key={name}
      aria-label={t.common.name}
      defaultValue={name}
      spellCheck={false}
      className="h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(13px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent"
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (reverting.current || !next) e.currentTarget.value = name;
        else if (next !== name) void dispatch('scene.rename_object', { id, name: next });
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
  );
}

function TransformRows({ id }: { id: string }) {
  const transform = useApp((s) => selectDocState(s).objects[id]?.transform);
  const live = useLiveEdit();
  const t = useT();
  if (!transform) return null;
  const params = (key: keyof Transform, i: number, value: number) => {
    const next = [...transform[key]] as Vec3;
    next[i] = value;
    return { items: [{ id, [key]: next }] };
  };
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map(({ key, unit, step }) => (
        <div key={key} role="group" aria-label={t.properties[key]}>
          <div className="mb-1 flex items-baseline gap-1.5 text-[calc(12px*var(--font-scale))]">
            <span className="text-dim">{t.properties[key]}</span>
            <span className="text-faint">{unit}</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {axes.map((axis, i) => (
              <ScrubField
                key={axis.label}
                label={axis.label}
                ariaLabel={`${t.properties[key]} ${axis.label}`}
                color={axis.color}
                value={transform[key][i]}
                step={step}
                onCommit={(value) => void dispatch('scene.set_transform', params(key, i, value))}
                onScrub={(value) => live.scrub('scene.set_transform', params(key, i, value))}
                onScrubEnd={live.end}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MeshStats({ mesh }: { mesh: PolyMesh }) {
  const stats = useMemo(() => meshStats(mesh), [mesh]);
  const t = useT();
  const items = [
    [t.properties.vertices, stats.vertices],
    [t.properties.edges, stats.edges],
    [t.properties.faces, stats.faces],
    [t.properties.triangles, stats.triangles],
  ] as const;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[calc(12.5px*var(--font-scale))]">
      {items.map(([title, count]) => (
        <div key={title} className="flex items-baseline justify-between">
          <dt className="text-dim">{title}</dt>
          <dd className="tnum text-text">{count.toLocaleString(t.locale)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** What the modifiers make of the mesh, when they change it. */
function EvaluatedStats({ id, mesh }: { id: string; mesh: PolyMesh }) {
  const evaluated = useApp((s) => (selectDocState(s).objects[id] ? evaluateObject(selectDocState(s), id).mesh : mesh));
  const t = useT();
  if (evaluated === mesh) return null;
  const n = (value: number) => value.toLocaleString(t.locale);
  return (
    <div className="mt-2 text-[calc(12.5px*var(--font-scale))]">
      <div className="mb-1 text-[calc(12px*var(--font-scale))] text-faint">{t.properties.withModifiers}</div>
      <dl className="grid grid-cols-2 gap-x-4">
        {(
          [
            [t.properties.vertices, evaluated.positions.length / 3],
            [t.properties.faces, evaluated.faces.length],
          ] as const
        ).map(([title, count]) => (
          <div key={title} className="flex items-baseline justify-between">
            <dt className="text-dim">{title}</dt>
            <dd className="tnum text-text">{n(count)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Edit mode: how much of the mesh is selected. */
function ElementSelection({ mesh }: { mesh: PolyMesh }) {
  const edit = useApp((s) => selectDocState(s).edit);
  const counts = useMemo(() => (edit ? elementCounts(edit, mesh) : null), [edit, mesh]);
  const t = useT();
  if (!edit || !counts) return null;
  return (
    <div className="flex items-baseline justify-between rounded-md bg-ink px-2 py-1.5 text-[calc(12.5px*var(--font-scale))] ring-1 ring-line ring-inset">
      <span className="text-dim">{t.properties.selected}</span>
      <span className="tnum">
        <span className={counts.selected ? 'text-accent' : 'text-text'}>{counts.selected.toLocaleString(t.locale)}</span>
        <span className="text-faint">{t.properties.of}</span>
        <span className="text-text">
          {counts.total.toLocaleString(t.locale)} {t.elements[edit.elementMode].of(counts.total)}
        </span>
      </span>
    </div>
  );
}

function ObjectProperties({ id }: { id: string }) {
  const name = useApp((s) => selectDocState(s).objects[id]?.name ?? '');
  const mesh = useApp((s) => selectDocState(s).objects[id]?.mesh);
  const smooth = useApp((s) => selectDocState(s).objects[id]?.smooth ?? false);
  const editing = useApp((s) => selectDocState(s).edit !== null);
  const t = useT();
  return (
    <div className="flex flex-col gap-4 px-3 pb-4">
      <NameField id={id} name={name} />
      {/* The transform belongs to object mode; edit mode shows what is selected in the mesh instead. */}
      {editing ? mesh && <ElementSelection mesh={mesh} /> : <TransformRows id={id} />}
      {mesh && (
        <div>
          <h3 className="mb-1.5 border-t border-line pt-3 text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.properties.mesh}</h3>
          <MeshStats mesh={mesh} />
          <EvaluatedStats id={id} mesh={mesh} />
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[calc(12.5px*var(--font-scale))] text-dim">{t.properties.smooth}</span>
            <Switch label={t.properties.smooth} checked={smooth} onChange={(next) => void dispatch('scene.set_smooth', { ids: [id], smooth: next })} />
          </div>
        </div>
      )}
      {!editing && <Materials id={id} />}
      <Modifiers id={id} />
    </div>
  );
}

export function Properties() {
  const activeId = useApp((s) => selectDocState(s).activeId);
  const hasObjects = useApp((s) => selectDocState(s).order.length > 0);
  const selected = useApp((s) => selectDocState(s).selection.length);
  const t = useT();
  return (
    <section aria-label={t.properties.title} className="flex min-h-0 min-w-0 flex-col border-t border-line">
      <header className="flex h-8 shrink-0 items-center justify-between px-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.properties.title}</h2>
        {/* The fields edit the active object only; say so when more is selected. */}
        {activeId && selected > 1 && <span className="text-[calc(12px*var(--font-scale))] text-faint">{t.properties.activeOf(selected)}</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeId ? (
          <ObjectProperties key={activeId} id={activeId} />
        ) : (
          <p className="px-3 pt-1 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">
            {hasObjects
              ? t.properties.selectHint
              : t.properties.emptyHint(shortcutLabel('add.menu') ?? '')}
          </p>
        )}
      </div>
    </section>
  );
}
