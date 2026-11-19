import { Plus, X } from 'lucide-react';
import type { FactoryValue } from '../../core/types';
import { useT } from '../../i18n';
import { TextField, smallButton } from '../minecraft/fields';
import { formatPropertyValue, freeKey, parsePropertyValue } from './propertyValue';

/**
 * Key-value rows of the free-form properties of a machine or a port. `onChange` gets what changed in the form the
 * commands take: a null value removes the key; a renamed key is the old one removed and the new one set.
 */
export function PropertiesEditor({ value, onChange }: { value: Readonly<Record<string, FactoryValue>>; onChange(changes: Record<string, FactoryValue | null>): void }) {
  const t = useT().factory.props;
  const entries = Object.entries(value);
  return (
    <div className="flex flex-col gap-1.5">
      {entries.length === 0 && <p className="text-[calc(12px*var(--font-scale))] text-faint">{t.empty}</p>}
      {entries.map(([key, val]) => (
        <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_1.5rem] items-center gap-1">
          <TextField label={t.key} value={key} mono onCommit={(next) => next && next !== key && !(next in value) && onChange({ [key]: null, [next]: val })} />
          <TextField label={t.value} value={formatPropertyValue(val)} mono onCommit={(text) => onChange({ [key]: parsePropertyValue(text) })} />
          <button
            type="button"
            aria-label={t.remove}
            title={t.remove}
            className="flex size-6 items-center justify-center rounded text-dim hover:bg-raised hover:text-danger"
            onClick={() => onChange({ [key]: null })}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      ))}
      <button type="button" className={smallButton} onClick={() => onChange({ [freeKey(Object.keys(value), 'property')]: '' })}>
        <Plus size={14} strokeWidth={1.75} />
        {t.add}
      </button>
      <p className="text-[calc(11px*var(--font-scale))] leading-snug text-faint">{t.hint}</p>
    </div>
  );
}
