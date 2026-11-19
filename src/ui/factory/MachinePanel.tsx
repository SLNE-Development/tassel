import { TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { selectPort } from '../../app/factorySelection';
import { selectDocState, useApp } from '../../app/store';
import { MAX_FOOTPRINT } from '../../core/minecraft/factory/model';
import { validateFactory, type FactoryIssue } from '../../core/minecraft/factory/validate';
import { cuboidFaces, type CuboidFaceName, type DocState, type FactoryMachine, type Vec3 } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu } from '../controls';
import { FieldRow, SectionTitle, TextField } from '../minecraft/fields';
import { ScrubField } from '../ScrubField';
import { PropertiesEditor } from './PropertiesEditor';

const setMachine = (changes: Record<string, unknown>) => void dispatch('factory.set_machine', changes);

const AXES = ['X', 'Y', 'Z'] as const;

/** Three integer fields; `min`/`max` bound each axis. */
function Vec3Fields({ label, value, min, max, onCommit }: { label: string; value: Readonly<Vec3>; min: number; max: (axis: number) => number; onCommit(value: Vec3): void }) {
  return (
    <div className="grid grid-cols-3 gap-1">
      {AXES.map((axis, i) => (
        <ScrubField
          key={axis}
          integer
          label={axis}
          ariaLabel={`${label} ${axis}`}
          color="var(--faint)"
          value={value[i]}
          step={0.1}
          min={min}
          max={max(i)}
          onCommit={(v) => onCommit(value.map((c, j) => (j === i ? v : c)) as Vec3)}
        />
      ))}
    </div>
  );
}

/** The six facings as toggles; at least one stays on. */
function FacingToggles({ machine }: { machine: FactoryMachine }) {
  const t = useT();
  return (
    <div className="grid grid-cols-6 gap-1" role="group" aria-label={t.factory.machine.facings}>
      {cuboidFaces.map((face) => {
        const on = machine.facings.includes(face);
        return (
          <button
            key={face}
            type="button"
            aria-pressed={on}
            title={t.mc.faces[face]}
            aria-label={t.mc.faces[face]}
            className={`h-7 min-w-0 truncate rounded-md px-1 text-[calc(12px*var(--font-scale))] ring-1 ring-inset ${
              on ? 'bg-raised text-text ring-accent' : 'bg-ink text-dim ring-line hover:ring-line-strong'
            }`}
            onClick={() => {
              const facings = on ? machine.facings.filter((f) => f !== face) : [...machine.facings, face];
              if (facings.length > 0) setMachine({ facings });
            }}
          >
            {t.mc.faceShort[face]}
          </button>
        );
      })}
    </div>
  );
}

/** Findings of the machine check; a click on one about a port selects that port. */
export function FactoryIssues({ issues, state }: { issues: readonly FactoryIssue[]; state: DocState }) {
  const t = useT().factory;
  if (issues.length === 0) return <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.machine.validOk}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, i) => {
        const subject = issue.portId !== undefined ? issue.portId : issue.objectId ? state.objects[issue.objectId]?.name : undefined;
        return (
          <li key={i}>
            <button
              type="button"
              className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[calc(12px*var(--font-scale))] leading-snug hover:bg-raised"
              onClick={() => {
                if (issue.portUid) selectPort(issue.portUid);
                else if (issue.objectId && state.objects[issue.objectId]) void dispatch('scene.select', { ids: [issue.objectId], mode: 'replace' });
              }}
            >
              <TriangleAlert size={13} strokeWidth={2} className={`mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-danger' : 'text-accent'}`} />
              <span className="min-w-0 text-dim">
                {subject && <span className="text-text">{subject}: </span>}
                {t.issues[issue.code]}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Machine-level settings of a factory model and the result of the machine check. */
export function MachinePanel() {
  const state = useApp((s) => selectDocState(s));
  const machine = state.factory;
  const issues = useMemo(() => validateFactory(state), [state]);
  const t = useT().factory.machine;
  const faces = useT().mc.faces;
  if (!machine) return null;
  const allowed = cuboidFaces.filter((f) => machine.facings.includes(f));
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow title={t.id}>
        <TextField label={t.id} value={machine.id} mono placeholder={t.idHint} onCommit={(id) => id && setMachine({ id })} />
      </FieldRow>
      <FieldRow title={t.displayName}>
        <TextField label={t.displayName} value={machine.displayName} onCommit={(displayName) => setMachine({ displayName })} />
      </FieldRow>
      <FieldRow title={t.footprint}>
        <Vec3Fields label={t.footprint} value={machine.footprint} min={1} max={() => MAX_FOOTPRINT} onCommit={(footprint) => setMachine({ footprint })} />
      </FieldRow>
      <FieldRow title={t.anchor}>
        <Vec3Fields label={t.anchor} value={machine.anchor} min={0} max={(i) => machine.footprint[i] - 1} onCommit={(anchor) => setMachine({ anchor })} />
      </FieldRow>
      <FieldRow title={t.facings}>
        <FacingToggles machine={machine} />
      </FieldRow>
      <FieldRow title={t.defaultFacing}>
        <PickMenu<CuboidFaceName>
          label={t.defaultFacing}
          value={machine.defaultFacing}
          placeholder={faces[machine.defaultFacing]}
          options={allowed.map((f) => ({ value: f, title: faces[f] }))}
          onChange={(defaultFacing) => setMachine({ defaultFacing })}
        />
      </FieldRow>
      <SectionTitle>{t.properties}</SectionTitle>
      <PropertiesEditor value={machine.properties} onChange={(properties) => setMachine({ properties })} />
      <SectionTitle>{t.check}</SectionTitle>
      <FactoryIssues issues={issues} state={state} />
    </div>
  );
}
