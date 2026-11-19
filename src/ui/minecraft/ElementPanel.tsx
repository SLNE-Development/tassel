import { FlipHorizontal2, RotateCcw, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { modelBox } from '../../core/minecraft/cuboid';
import { cuboidFaces, type Cuboid, type CuboidFaceName, type SceneObject, type Vec3 } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch, runAction } from '../actions';
import { PickMenu, Switch } from '../controls';
import { useLiveEdit } from '../live';
import { ScrubField } from '../ScrubField';
import { boxParams, type BoxField } from './elementEdits';
import { FieldRow, SectionTitle, smallButton, TextField } from './fields';

const axes = [
  { label: 'X', color: 'var(--axis-x)' },
  { label: 'Y', color: 'var(--axis-y)' },
  { label: 'Z', color: 'var(--axis-z)' },
] as const;

/** Marker colours of the outliner (index 0..7). */
export const markerColors = ['#8d96a0', '#e0697a', '#e8a04a', '#e9d24a', '#6cc070', '#4fb8b0', '#5b95e8', '#b087e0'] as const;

type CuboidObject = SceneObject & { cuboid: Cuboid };

function Vec3Fields({ obj, field, title, unit, step, locked }: { obj: CuboidObject; field: BoxField; title: string; unit: string; step: number; locked: boolean }) {
  const live = useLiveEdit();
  const box = modelBox(obj);
  const values: Vec3 =
    field === 'position' ? box.from : field === 'size' ? ([0, 1, 2].map((i) => Math.round((box.to[i] - box.from[i]) * 1e4) / 1e4) as Vec3) : field === 'pivot' ? box.origin : obj.transform.rotation;
  return (
    <div role="group" aria-label={title} className={locked ? 'pointer-events-none opacity-50' : undefined}>
      <div className="mb-1 flex items-baseline gap-1.5 text-[calc(12px*var(--font-scale))]">
        <span className="text-dim">{title}</span>
        <span className="text-faint">{unit}</span>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {axes.map((axis, i) => {
          const edit = (value: number) => boxParams(obj, field, i, value);
          return (
            <ScrubField
              key={axis.label}
              label={axis.label}
              ariaLabel={`${title} ${axis.label}`}
              color={axis.color}
              value={values[i]}
              step={step}
              min={field === 'size' ? 0 : -Infinity}
              onCommit={(value) => {
                const { command, params } = edit(value);
                void dispatch(command, params);
              }}
              onScrub={(value) => {
                const { command, params } = edit(value);
                live.scrub(command, params);
              }}
              onScrubEnd={live.end}
            />
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ title, checked, onChange }: { title: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[calc(12.5px*var(--font-scale))] text-dim">{title}</span>
      <Switch label={title} checked={checked} onChange={onChange} />
    </div>
  );
}

function ToolButton({ action, icon, title }: { action: string; icon?: ReactNode; title: string }) {
  return (
    <button className={smallButton} title={title} aria-label={title} onClick={() => void runAction(action)}>
      {icon}
      <span className="truncate">{title}</span>
    </button>
  );
}

/** Flip and 90 degree turns per axis, centring and clean-up commands for the selected elements. */
function Tools() {
  const t = useT().mc.element;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <ToolButton key={axis} action={`mc.flip_${axis}`} icon={<FlipHorizontal2 size={13} strokeWidth={1.75} />} title={t.flipShort(axis.toUpperCase())} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {(['x', 'y', 'z'] as const).map((axis) => (
          <div key={axis} className="flex min-w-0 gap-0.5">
            <button className={`${smallButton} flex-1 px-1`} aria-label={t.rotateTitle(axis.toUpperCase(), -1)} title={t.rotateTitle(axis.toUpperCase(), -1)} onClick={() => void runAction(`mc.rotate_${axis}_minus`)}>
              <RotateCcw size={12} strokeWidth={1.75} />
              {axis.toUpperCase()}
            </button>
            <button className={`${smallButton} flex-1 px-1`} aria-label={t.rotateTitle(axis.toUpperCase(), 1)} title={t.rotateTitle(axis.toUpperCase(), 1)} onClick={() => void runAction(`mc.rotate_${axis}_plus`)}>
              <RotateCw size={12} strokeWidth={1.75} />
              {axis.toUpperCase()}
            </button>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <ToolButton action="mc.center_pivot" title={t.centerPivot} />
        <ToolButton action="mc.center_block" title={t.centerOnBlock} />
        <ToolButton action="mc.auto_cullface" title={t.autoCullface} />
        <ToolButton action="mc.remove_blank_faces" title={t.removeBlankFaces} />
      </div>
    </div>
  );
}

function Numeric({ title, value, step, min, max, integer, onCommit, onScrub, onScrubEnd }: {
  title: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  integer?: boolean;
  onCommit(value: number): void;
  onScrub(value: number): void;
  onScrubEnd(): void;
}) {
  return (
    <ScrubField wide label={title} ariaLabel={title} color="var(--dim)" value={value} step={step} min={min} max={max} integer={integer} onCommit={onCommit} onScrub={onScrub} onScrubEnd={onScrubEnd} />
  );
}

/** The properties of the active Minecraft element in model space (pixels). */
export function ElementPanel({ id }: { id: string }) {
  const obj = useApp((s) => selectDocState(s).objects[id]) as CuboidObject | undefined;
  const t = useT().mc;
  const live = useLiveEdit();
  if (!obj?.cuboid) return null;
  const c = obj.cuboid;
  const update = (params: Record<string, unknown>) => void dispatch('cuboid.update', { ids: [id], ...params });
  const scrub = (params: Record<string, unknown>) => live.scrub('cuboid.update', { ids: [id], ...params });
  const shadeOptions = [{ value: 'none', title: t.element.shadeNone }, ...cuboidFaces.map((f) => ({ value: f, title: t.faces[f] }))];

  return (
    <div className="flex flex-col gap-3">
      <TextField label={t.element.name} value={obj.name} onCommit={(name) => name && void dispatch('scene.rename_object', { id, name })} />
      <Vec3Fields obj={obj} field="position" title={t.element.position} unit="px" step={0.1} locked={c.locked} />
      <Vec3Fields obj={obj} field="size" title={t.element.size} unit="px" step={0.1} locked={c.locked} />
      <Vec3Fields obj={obj} field="pivot" title={t.element.pivot} unit="px" step={0.1} locked={c.locked} />
      <Vec3Fields obj={obj} field="rotation" title={t.element.rotation} unit="°" step={0.5} locked={c.locked} />
      <Numeric
        title={t.element.inflate}
        value={c.inflate}
        step={0.05}
        onCommit={(inflate) => update({ inflate })}
        onScrub={(inflate) => scrub({ inflate })}
        onScrubEnd={live.end}
      />

      <SectionTitle>{t.element.properties}</SectionTitle>
      <div className="flex flex-col gap-2.5">
        <ToggleRow title={t.element.shade} checked={c.shade} onChange={(shade) => update({ shade })} />
        <ToggleRow title={t.element.rescale} checked={c.rescale} onChange={(rescale) => update({ rescale })} />
        <Numeric
          title={t.element.lightEmission}
          value={c.lightEmission}
          step={0.1}
          integer
          min={0}
          max={15}
          onCommit={(lightEmission) => update({ lightEmission })}
          onScrub={(lightEmission) => scrub({ lightEmission })}
          onScrubEnd={live.end}
        />
        <FieldRow title={t.element.shadeOverride}>
          <PickMenu<string>
            label={t.element.shadeOverride}
            value={c.shadeDirectionOverride ?? 'none'}
            placeholder={t.element.shadeNone}
            options={shadeOptions}
            onChange={(value) => update({ shadeDirectionOverride: value === 'none' ? null : (value as CuboidFaceName) })}
          />
        </FieldRow>
        <ToggleRow title={t.element.locked} checked={c.locked} onChange={(locked) => update({ locked })} />
        <ToggleRow title={t.element.export} checked={c.export} onChange={(next) => update({ export: next })} />
        <FieldRow title={t.element.color}>
          <div role="radiogroup" aria-label={t.element.color} className="flex flex-wrap gap-1">
            {markerColors.map((color, i) => (
              <button
                key={color}
                role="radio"
                aria-checked={c.color === i}
                aria-label={`${t.element.color} ${i + 1}`}
                className={`size-4 rounded-full ring-offset-1 ring-offset-panel ${c.color === i ? 'ring-2 ring-text' : 'hover:ring-1 hover:ring-faint'}`}
                style={{ background: color }}
                onClick={() => update({ color: i })}
              />
            ))}
          </div>
        </FieldRow>
      </div>

      <SectionTitle>{t.element.tools}</SectionTitle>
      <Tools />
    </div>
  );
}
