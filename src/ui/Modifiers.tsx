import { Menu } from '@base-ui/react/menu';
import { ArrowDown, ArrowUp, Plus, TriangleAlert, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { selectDocState, useApp } from '../app/store';
import { evaluateObject } from '../core/modifiers/evaluate';
import { booleanOperations, modifierTypes, type Modifier, type Vec3 } from '../core/types';
import { dispatch } from './actions';
import { PickMenu, Segmented, Switch } from './controls';
import { booleanLabels, modifierLabels } from './labels';
import { useLiveEdit } from './live';
import { itemClass, popupClass } from './menu';
import { ScrubField } from './ScrubField';
import { Tip } from './Tip';

const axes = [
  { key: 'x', label: 'X', color: 'var(--axis-x)' },
  { key: 'y', label: 'Y', color: 'var(--axis-y)' },
  { key: 'z', label: 'Z', color: 'var(--axis-z)' },
] as const;

const iconButton =
  'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[calc(12px*var(--font-scale))] text-dim">{title}</span>
      {children}
    </div>
  );
}

function Params({ objectId, modifier }: { objectId: string; modifier: Modifier }) {
  const live = useLiveEdit();
  const order = useApp((s) => selectDocState(s).order);
  const objects = useApp((s) => selectDocState(s).objects);
  const params = (change: Record<string, unknown>) => ({ objectId, modifierId: modifier.id, ...change });
  const update = (change: Record<string, unknown>) => void dispatch('modifier.update', params(change));
  /** Scrub handlers: live preview that ends up as one undo step. */
  const scrub = (change: (value: number) => Record<string, unknown>) => ({
    onCommit: (value: number) => update(change(value)),
    onScrub: (value: number) => live.scrub('modifier.update', params(change(value))),
    onScrubEnd: live.end,
  });

  switch (modifier.type) {
    case 'mirror':
      return (
        <>
          <Row title="Achsen">
            <div role="group" aria-label="Spiegelachsen" className="grid grid-cols-3 gap-1">
              {axes.map((axis) => {
                const on = modifier.axes[axis.key];
                return (
                  <button
                    key={axis.key}
                    aria-pressed={on}
                    aria-label={`Spiegeln an ${axis.label}`}
                    className={`h-7 rounded-md text-[calc(11.5px*var(--font-scale))] font-semibold ring-1 ring-inset ${on ? 'bg-raised ring-line-strong' : 'bg-ink opacity-45 ring-line hover:opacity-80'}`}
                    style={{ color: axis.color }}
                    onClick={() => update({ axes: { [axis.key]: !on } })}
                  >
                    {axis.label}
                  </button>
                );
              })}
            </div>
          </Row>
          <ScrubField wide label="Verschmelzabstand" ariaLabel="Verschmelzabstand" color="var(--dim)" value={modifier.mergeDistance} step={0.001} min={0} {...scrub((v) => ({ mergeDistance: v }))} />
        </>
      );
    case 'subdivision':
      return (
        <Row title="Stufen">
          <Segmented label="Stufen" value={modifier.levels} options={[1, 2, 3, 4].map((n) => ({ value: n, title: n, ariaLabel: `${n}` }))} onChange={(levels) => update({ levels })} />
        </Row>
      );
    case 'array':
      return (
        <>
          <ScrubField wide label="Anzahl" ariaLabel="Anzahl" color="var(--dim)" value={modifier.count} step={0.1} integer min={1} max={1000} {...scrub((v) => ({ count: v }))} />
          <div role="group" aria-label="Versatz">
            <div className="mb-1 flex items-baseline gap-1.5 text-[calc(12px*var(--font-scale))]">
              <span className="text-dim">Versatz</span>
              <span className="text-faint">m</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {axes.map((axis, i) => (
                <ScrubField
                  key={axis.key}
                  label={axis.label}
                  ariaLabel={`Versatz ${axis.label}`}
                  color={axis.color}
                  value={modifier.offset[i]}
                  step={0.01}
                  {...scrub((v) => ({ offset: modifier.offset.map((old, j) => (j === i ? v : old)) as Vec3 }))}
                />
              ))}
            </div>
          </div>
        </>
      );
    case 'boolean': {
      const options = order.filter((id) => id !== objectId).map((id) => ({ value: id, title: objects[id].name }));
      return (
        <>
          <Segmented label="Operation" value={modifier.operation} options={booleanOperations.map((op) => ({ value: op, title: booleanLabels[op] }))} onChange={(operation) => update({ operation })} />
          <Row title="Zielobjekt">
            <PickMenu
              label="Zielobjekt"
              value={modifier.targetId}
              placeholder={options.length ? 'Objekt wählen' : 'Kein weiteres Objekt'}
              options={options}
              onChange={(targetId) => update({ targetId })}
            />
          </Row>
        </>
      );
    }
  }
}

function Card({ objectId, modifier, index, count, error: failure, editing }: { objectId: string; modifier: Modifier; index: number; count: number; error?: string; editing: boolean }) {
  const { title, icon: Icon } = modifierLabels[modifier.type];
  // A boolean without a target is unfinished rather than broken; its picker already asks for one.
  const error = modifier.type === 'boolean' && !modifier.targetId ? undefined : failure;
  const ref = { objectId, modifierId: modifier.id };
  return (
    <li aria-label={title} className={`rounded-md bg-raised/45 ring-1 ring-inset ${error ? 'ring-danger/60' : 'ring-line'}`}>
      <div className="flex h-8 items-center gap-1 pr-1 pl-2">
        <Icon size={14} strokeWidth={1.75} className={`shrink-0 ${modifier.enabled ? 'text-dim' : 'text-faint'}`} />
        <span className={`min-w-0 flex-1 truncate pl-1 text-[calc(12.5px*var(--font-scale))] ${modifier.enabled ? 'text-text' : 'text-faint'}`}>{title}</span>
        <Tip label={modifier.enabled ? 'Ausschalten' : 'Einschalten'}>
          <span className="mr-1 flex">
            <Switch label={`${title} aktiv`} checked={modifier.enabled} onChange={(enabled) => void dispatch('modifier.update', { ...ref, enabled })} />
          </span>
        </Tip>
        <Tip label="Nach oben">
          <button aria-label="Nach oben" className={iconButton} disabled={index === 0} onClick={() => void dispatch('modifier.move', { ...ref, index: index - 1 })}>
            <ArrowUp size={13} />
          </button>
        </Tip>
        <Tip label="Nach unten">
          <button aria-label="Nach unten" className={iconButton} disabled={index === count - 1} onClick={() => void dispatch('modifier.move', { ...ref, index: index + 1 })}>
            <ArrowDown size={13} />
          </button>
        </Tip>
        <Tip label="Entfernen">
          <button aria-label="Entfernen" className={iconButton} onClick={() => void dispatch('modifier.remove', ref)}>
            <X size={13} />
          </button>
        </Tip>
      </div>
      <div className="flex flex-col gap-1.5 px-2 pb-2">
        <Params objectId={objectId} modifier={modifier} />
        {error && (
          <p role="alert" className="flex gap-1.5 pt-0.5 text-[calc(12px*var(--font-scale))] leading-snug text-danger select-text">
            <TriangleAlert size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </p>
        )}
        <div className="flex justify-end">
          <Tip label={editing ? 'Geht nur im Objektmodus' : 'Ins Netz einrechnen und entfernen'}>
            <button
              // Not `disabled`, so the tooltip can still say why.
              aria-disabled={editing}
              className={`h-6 rounded-md px-2 text-[calc(12px*var(--font-scale))] ring-1 ring-inset ${
                editing ? 'cursor-default text-faint ring-line' : 'text-text ring-line-strong hover:bg-raised hover:ring-faint'
              }`}
              onClick={() => !editing && void dispatch('modifier.apply', ref)}
            >
              Anwenden
            </button>
          </Tip>
        </div>
      </div>
    </li>
  );
}

/** The active object's modifier stack, evaluated top to bottom. */
export function Modifiers({ id }: { id: string }) {
  const modifiers = useApp((s) => selectDocState(s).objects[id]?.modifiers);
  const editing = useApp((s) => selectDocState(s).edit !== null);
  // Evaluation is cached, so asking again after every state change is cheap.
  const errors = useApp((s) => (selectDocState(s).objects[id]?.modifiers.length ? evaluateObject(selectDocState(s), id).errors : undefined));
  if (!modifiers) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between border-t border-line pt-2">
        <h3 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">Modifikatoren</h3>
        <Menu.Root>
          <Menu.Trigger
            aria-label="Modifikator hinzufügen"
            className="-mr-1 flex h-6 items-center gap-1 rounded-md pr-2 pl-1.5 text-[calc(12px*var(--font-scale))] text-dim hover:bg-raised hover:text-text data-[popup-open]:bg-raised data-[popup-open]:text-accent"
          >
            <Plus size={13} />
            Hinzufügen
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50 outline-none">
              <Menu.Popup className={popupClass}>
                {modifierTypes.map((type) => {
                  const { title, icon: Icon } = modifierLabels[type];
                  return (
                    <Menu.Item key={type} className={itemClass} onClick={() => void dispatch('modifier.add', { objectId: id, type })}>
                      <span className="flex w-4 shrink-0 justify-center">
                        <Icon size={15} strokeWidth={1.75} />
                      </span>
                      {title}
                    </Menu.Item>
                  );
                })}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
      {modifiers.length === 0 ? (
        <p className="text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">Modifikatoren verändern das Netz, ohne es anzutasten: spiegeln, glätten, vervielfachen, verschneiden.</p>
      ) : (
        <ul aria-label="Modifikatoren" className="flex flex-col gap-1.5">
          {modifiers.map((modifier, index) => (
            <Card key={modifier.id} objectId={id} modifier={modifier} index={index} count={modifiers.length} error={errors?.[modifier.id]} editing={editing} />
          ))}
        </ul>
      )}
    </div>
  );
}
