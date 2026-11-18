import { Dialog } from '@base-ui/react/dialog';
import { Check, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { execute, selectDocState, useApp } from '../../app/store';
import { BAKE_CANCELLED, cancelBake, defaultDistance, useBakeProgress } from '../../bake';
import { evaluateObject } from '../../core/modifiers/evaluate';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { Segmented, Switch } from '../controls';
import { ScrubField } from '../ScrubField';
import { notifyError } from '../toast';
import { useBakeDialog } from './bakeStore';

type BakeType = 'normal' | 'ao';

const sizes = [256, 512, 1024, 2048, 4096] as const;
const sampleCounts = [16, 32, 64, 128, 256] as const;
/** Below this share of texels with a source, the result gets a warning. */
const LOW_COVERAGE = 0.9;

interface Outcome {
  type: BakeType;
  name: string;
  coverage: number;
}

const labelClass = 'text-[calc(12.5px*var(--font-scale))] text-dim';
const smallButton = 'h-6 shrink-0 rounded-md px-2 text-[calc(12px*var(--font-scale))] text-text ring-1 ring-line-strong ring-inset hover:bg-raised hover:ring-faint';

function Row({ label, top = false, children }: { label: string; top?: boolean; children: ReactNode }) {
  return (
    <>
      <span className={`${labelClass} ${top ? 'self-start pt-1.5' : ''}`}>{label}</span>
      <div className="flex min-h-7 min-w-0 items-center justify-end gap-2">{children}</div>
    </>
  );
}

function Note({ children, action, onAction }: { children: ReactNode; action?: string; onAction?(): void }) {
  return (
    <div role="note" className="col-span-2 flex items-center gap-2.5 rounded-md bg-ink px-2.5 py-1.5 ring-1 ring-line ring-inset">
      <p className="min-w-0 flex-1 text-[calc(12px*var(--font-scale))] leading-snug text-dim">{children}</p>
      {action && (
        <button className={smallButton} onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

/** The other objects of the document as a checklist. */
function ObjectList({ label, ids, checked, disabled, onToggle }: { label: string; ids: readonly string[]; checked: ReadonlySet<string>; disabled: boolean; onToggle(id: string): void }) {
  const objects = useApp((s) => selectDocState(s).objects);
  const t = useT().bake;
  if (ids.length === 0) return <p className="w-full py-1 text-[calc(12.5px*var(--font-scale))] text-faint">{t.noOthers}</p>;
  return (
    <ul aria-label={label} className="max-h-36 w-full overflow-y-auto rounded-md bg-ink p-0.5 ring-1 ring-line ring-inset">
      {ids.map((id) => {
        const on = checked.has(id);
        return (
          <li key={id}>
            <button
              role="checkbox"
              aria-checked={on}
              disabled={disabled}
              className="flex h-6.5 w-full items-center gap-2 rounded-[4px] px-1.5 text-left text-[calc(12.5px*var(--font-scale))] hover:bg-raised disabled:opacity-60"
              onClick={() => onToggle(id)}
            >
              <span className={`flex size-3.5 shrink-0 items-center justify-center rounded-[3px] ring-1 ring-inset ${on ? 'bg-accent text-accent-ink ring-accent' : 'ring-line-strong'}`}>
                {on && <Check size={11} strokeWidth={3} />}
              </span>
              <span className={`truncate ${on ? 'text-text' : 'text-dim'}`}>{objects[id]?.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function BakeBody({ targetId }: { targetId: string }) {
  const t = useT().bake;
  const state = useApp(selectDocState);
  const target = state.objects[targetId];
  const progress = useBakeProgress((s) => s.progress);

  const [type, setType] = useState<BakeType>('normal');
  // Both lists start with the other selected objects: the usual way to say "bake these onto that".
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(state.selection.filter((id) => id !== targetId)));
  const [size, setSize] = useState<number>(1024);
  const [samples, setSamples] = useState<number>(64);
  /** Ray lengths the user set; null follows the default, which depends on the objects. */
  const [maxDistance, setMaxDistance] = useState<number | null>(null);
  const [aoDistance, setAoDistance] = useState<number | null>(null);
  const [assign, setAssign] = useState(true);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const others = state.order.filter((id) => id !== targetId);
  const chosen = others.filter((id) => picked.has(id));
  const chosenKey = chosen.join(' ');
  const hasUvs = useMemo(() => (target ? evaluateObject(state, targetId).mesh.uvs !== undefined : false), [state, target, targetId]);
  // Unchanged objects keep their identity, so this only recomputes when the geometry involved changes.
  const autoDistance = useMemo(
    () => (target ? defaultDistance(state, type, targetId, type === 'ao' ? chosen : []) : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.objects, type, targetId, type === 'ao' ? chosenKey : ''],
  );
  if (!target) return null;

  const distance = (type === 'normal' ? maxDistance : aoDistance) ?? autoDistance;
  const setDistance = type === 'normal' ? setMaxDistance : setAoDistance;
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const bake = async () => {
    setRunning(true);
    setOutcome(null);
    try {
      const shared = { targetId, size, assign };
      const result = (
        type === 'normal'
          ? await execute('bake.normal', { ...shared, sourceIds: chosen, maxDistance: maxDistance ?? undefined })
          : await execute('bake.ao', { ...shared, includeIds: chosen, samples, distance: aoDistance ?? undefined })
      ) as { name: string; coverage?: number };
      setOutcome({ type, name: result.name, coverage: result.coverage ?? 1 });
    } catch (error) {
      if (!(error instanceof Error && error.message === BAKE_CANCELLED)) notifyError(error);
    } finally {
      setRunning(false);
    }
  };

  const percent = Math.round((progress ?? 0) * 100);
  const coverage = outcome ? Math.round(outcome.coverage * 100) : 0;
  const low = outcome?.type === 'normal' && outcome.coverage < LOW_COVERAGE;
  const ready = hasUvs && (type === 'ao' || chosen.length > 0);

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 overflow-y-auto px-5 py-4">
        <div className="col-span-2">
          <Segmented
            label={t.type}
            value={type}
            options={[
              { value: 'normal', title: t.types.normal },
              { value: 'ao', title: t.types.ao },
            ]}
            onChange={(next) => {
              if (running) return;
              setType(next);
              setOutcome(null);
            }}
          />
        </div>
        <p className="col-span-2 -mt-0.5 mb-1 text-[calc(12px*var(--font-scale))] leading-snug text-faint">{type === 'normal' ? t.aboutNormal : t.aboutAo}</p>

        <Row label={t.target}>
          <span className="truncate text-[calc(12.5px*var(--font-scale))] text-text">{target.name}</span>
        </Row>
        {!hasUvs && (
          <Note action={target.mesh.uvs ? undefined : t.unwrap} onAction={() => void dispatch('uv.unwrap', { objectId: targetId, method: 'smart' })}>
            {t.noUvs}
          </Note>
        )}
        {hasUvs && type === 'normal' && !target.smooth && (
          <Note action={t.shadeSmooth} onAction={() => void dispatch('scene.set_smooth', { ids: [targetId], smooth: true })}>
            {t.flatTarget}
          </Note>
        )}

        <Row label={type === 'normal' ? t.sources : t.occluders} top>
          <ObjectList label={type === 'normal' ? t.sources : t.occluders} ids={others} checked={picked} disabled={running} onToggle={toggle} />
        </Row>

        <Row label={t.size}>
          <div className="min-w-0 flex-1">
            <Segmented label={t.size} value={size} options={sizes.map((value) => ({ value, title: String(value), ariaLabel: t.pixels(value) }))} onChange={(next) => !running && setSize(next)} />
          </div>
        </Row>
        {type === 'ao' && (
          <Row label={t.samples}>
            <div className="min-w-0 flex-1">
              <Segmented label={t.samples} value={samples} options={sampleCounts.map((value) => ({ value, title: String(value) }))} onChange={(next) => !running && setSamples(next)} />
            </div>
          </Row>
        )}
        <Row label={type === 'normal' ? t.maxDistance : t.distance}>
          {(type === 'normal' ? maxDistance : aoDistance) !== null && (
            <button className={smallButton} disabled={running} onClick={() => setDistance(null)}>
              {t.auto}
            </button>
          )}
          <div className="w-28 shrink-0">
            <ScrubField
              label="m"
              ariaLabel={type === 'normal' ? t.maxDistance : t.distance}
              color="var(--faint)"
              value={distance}
              step={Math.max(autoDistance, 0.001) / 100}
              min={0.0001}
              onCommit={(value) => !running && setDistance(value)}
            />
          </div>
        </Row>
        <Row label={t.assign}>
          <Switch checked={assign} label={t.assign} onChange={(next) => !running && setAssign(next)} />
        </Row>
      </div>

      <footer className="flex min-h-14 shrink-0 items-center gap-3 border-t border-line py-2.5 pr-3 pl-5">
        <div className="min-w-0 flex-1" aria-live="polite">
          {running ? (
            <div className="flex items-center gap-3">
              <div role="progressbar" aria-label={t.baking} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink ring-1 ring-line ring-inset">
                <div className="h-full rounded-full bg-accent transition-[width] duration-150 ease-linear" style={{ width: `${percent}%` }} />
              </div>
              <span className="tnum w-9 shrink-0 text-right text-[calc(12.5px*var(--font-scale))] text-text">{percent} %</span>
            </div>
          ) : outcome ? (
            <div className="flex items-start gap-2">
              {low ? <TriangleAlert size={15} className="mt-0.5 shrink-0 text-danger" /> : <Check size={15} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ok" />}
              <p className="min-w-0 text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">
                <span className="text-text">{t.done(outcome.name)}</span>{' '}
                {outcome.type === 'ao' ? t.doneAo : low ? t.lowCoverage(coverage) : t.coverage(coverage)}
              </p>
            </div>
          ) : (
            !ready && hasUvs && <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.pickSource}</p>
          )}
        </div>
        {running ? (
          <button className="h-8 shrink-0 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-dim ring-1 ring-line-strong ring-inset hover:bg-raised hover:text-text" onClick={cancelBake}>
            {t.cancel}
          </button>
        ) : (
          <button
              disabled={!ready}
              className="h-8 shrink-0 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110 disabled:bg-raised disabled:text-faint disabled:hover:brightness-100"
              onClick={() => void bake()}
            >
              {outcome ? t.bakeAgain : t.bake}
          </button>
        )}
      </footer>
    </>
  );
}

/** "Backen…": bakes a normal map or ambient occlusion for the active object. */
export function BakeDialog() {
  const t = useT();
  const targetId = useBakeDialog((s) => s.targetId);
  const running = useBakeProgress((s) => s.progress !== null);
  const close = () => useBakeDialog.setState({ targetId: null });
  return (
    // While a bake runs the dialog stays: its footer is where the bake is watched and cancelled.
    <Dialog.Root open={targetId !== null} onOpenChange={(open) => !open && !running && close()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(30rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none">
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.bake.title}</Dialog.Title>
            <Dialog.Close
              aria-label={t.common.close}
              disabled={running}
              className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text disabled:text-faint/50 disabled:hover:bg-transparent"
            >
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          {targetId !== null && <BakeBody key={targetId} targetId={targetId} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
