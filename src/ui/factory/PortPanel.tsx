import { Menu } from '@base-ui/react/menu';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { selectPort, useFactorySelection } from '../../app/factorySelection';
import { execute, selectDocState, useApp } from '../../app/store';
import { builtinConnectors, builtinResources } from '../../core/minecraft/factory/model';
import { portKinds, type CuboidFaceName, type FactoryPort, type PortKind, type Vec3 } from '../../core/types';
import { cuboidFaces } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu, Segmented } from '../controls';
import { itemClass, popupClass } from '../menu';
import { FieldRow, SectionTitle, TextField, smallButton } from '../minecraft/fields';
import { ScrubField } from '../ScrubField';
import { notifyError } from '../toast';
import { KindDot } from './KindDot';
import { PropertiesEditor } from './PropertiesEditor';
import { parseOptionalNumber, parseTags } from './propertyValue';

/** Where a new port of each kind goes first: the side a machine usually takes things in, gives them out, or (both) the top. */
const startFace: Record<PortKind, CuboidFaceName> = { input: 'west', output: 'east', bidirectional: 'up' };

const update = (port: FactoryPort, changes: Record<string, unknown>) => void dispatch('factory.update_port', { port: port.uid, ...changes });

/** Runs a command that returns a port and selects that port. */
function runAndSelect(id: string, params: object): void {
  execute(id, params)
    .then((port) => selectPort((port as { uid: string }).uid))
    .catch(notifyError);
}

function AddMenu() {
  const t = useT().factory;
  return (
    <Menu.Root>
      <Menu.Trigger aria-label={t.ports.add} title={t.ports.add} className={`${smallButton} aspect-square w-7 px-0`}>
        <Plus size={15} strokeWidth={1.75} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>
            {portKinds.map((kind) => (
              <Menu.Item key={kind} className={itemClass} onClick={() => runAndSelect('factory.add_port', { kind, face: startFace[kind] })}>
                <KindDot port={{ kind, face: startFace[kind] }} />
                {t.port.kinds[kind]}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function ToolButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} className={`${smallButton} aspect-square w-7 px-0`} onClick={onClick}>
      {children}
    </button>
  );
}

function PortList({ ports, selected }: { ports: readonly FactoryPort[]; selected: FactoryPort | undefined }) {
  const t = useT().factory;
  const index = selected ? ports.indexOf(selected) : -1;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        <AddMenu />
        <ToolButton label={t.ports.duplicate} disabled={!selected} onClick={() => selected && runAndSelect('factory.duplicate_port', { port: selected.uid })}>
          <Copy size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton
          label={t.ports.remove}
          disabled={!selected}
          onClick={() => {
            if (!selected) return;
            selectPort(null);
            void dispatch('factory.remove_ports', { ports: [selected.uid] });
          }}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </ToolButton>
        <span className="flex-1" />
        <ToolButton label={t.ports.moveUp} disabled={index <= 0} onClick={() => selected && void dispatch('factory.reorder_port', { port: selected.uid, index: index - 1 })}>
          <ArrowUp size={14} strokeWidth={1.75} />
        </ToolButton>
        <ToolButton label={t.ports.moveDown} disabled={index < 0 || index >= ports.length - 1} onClick={() => selected && void dispatch('factory.reorder_port', { port: selected.uid, index: index + 1 })}>
          <ArrowDown size={14} strokeWidth={1.75} />
        </ToolButton>
      </div>
      {ports.length === 0 ? (
        <p className="text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{t.ports.empty}</p>
      ) : (
        <ul aria-label={t.ports.list} className="flex flex-col gap-px">
          {ports.map((port) => (
            <li key={port.uid}>
              <button
                type="button"
                aria-pressed={port === selected}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[calc(12.5px*var(--font-scale))] ${
                  port === selected ? 'bg-raised text-text ring-1 ring-accent ring-inset' : 'text-dim hover:bg-raised hover:text-text'
                }`}
                onClick={() => selectPort(port.uid)}
              >
                <KindDot port={port} />
                <span className="min-w-0 flex-1 truncate font-mono">{port.id}</span>
                <span className="shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{port.resource}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const AXES = ['X', 'Y', 'Z'] as const;

function PortEditor({ port }: { port: FactoryPort }) {
  const t = useT().factory.port;
  const faces = useT().mc.faces;
  const text = (label: string, value: string, field: string, extra?: { list?: string; mono?: boolean; placeholder?: string }) => (
    <FieldRow title={label}>
      <TextField label={label} value={value} {...extra} onCommit={(next) => update(port, { [field]: next })} />
    </FieldRow>
  );
  const optionalNumber = (label: string, value: number | null, field: 'capacity' | 'rate') => (
    <FieldRow title={label}>
      <TextField
        label={label}
        value={value === null ? '' : String(value)}
        placeholder={t.none}
        onCommit={(next) => {
          const parsed = parseOptionalNumber(next);
          if (parsed !== undefined) update(port, { [field]: parsed });
        }}
      />
    </FieldRow>
  );
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow title={t.id}>
        <TextField label={t.id} value={port.id} mono onCommit={(newId) => newId && update(port, { newId })} />
      </FieldRow>
      {text(t.name, port.name, 'name')}
      <FieldRow title={t.kind}>
        <Segmented<PortKind> label={t.kind} value={port.kind} options={portKinds.map((kind) => ({ value: kind, title: t.kinds[kind] }))} onChange={(kind) => update(port, { kind })} />
      </FieldRow>
      {text(t.resource, port.resource, 'resource', { list: 'factory-resources', mono: true })}
      {text(t.connector, port.connector, 'connector', { list: 'factory-connectors', mono: true })}
      <datalist id="factory-resources">
        {builtinResources.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <datalist id="factory-connectors">
        {builtinConnectors.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <FieldRow title={t.face}>
        <PickMenu<string>
          label={t.face}
          value={port.face ?? ''}
          placeholder={t.noFace}
          options={[{ value: '', title: t.noFace }, ...cuboidFaces.map((f) => ({ value: f, title: faces[f] }))]}
          onChange={(face) => update(port, { face: face === '' ? null : face })}
        />
      </FieldRow>
      <FieldRow title={t.position}>
        <div className="grid grid-cols-3 gap-1">
          {AXES.map((axis, i) => (
            <ScrubField
              key={axis}
              integer
              label={axis}
              ariaLabel={`${t.position} ${axis}`}
              color="var(--faint)"
              value={port.position[i]}
              step={0.1}
              onCommit={(v) => update(port, { position: port.position.map((c, j) => (j === i ? v : c)) as Vec3 })}
            />
          ))}
        </div>
      </FieldRow>
      <FieldRow title={t.size}>
        <div className="grid grid-cols-2 gap-1">
          {(['W', 'H'] as const).map((label, i) => (
            <ScrubField
              key={label}
              label={label}
              ariaLabel={`${t.size} ${label}`}
              color="var(--faint)"
              value={port.size[i]}
              step={0.1}
              min={0}
              onCommit={(v) => update(port, { size: i === 0 ? [v, port.size[1]] : [port.size[0], v] })}
            />
          ))}
        </div>
      </FieldRow>
      {optionalNumber(t.capacity, port.capacity, 'capacity')}
      {optionalNumber(t.rate, port.rate, 'rate')}
      <FieldRow title={t.tags}>
        <TextField label={t.tags} value={port.tags.join(', ')} mono placeholder={t.tagsHint} onCommit={(next) => update(port, { tags: parseTags(next) })} />
      </FieldRow>
      <SectionTitle>{t.properties}</SectionTitle>
      <PropertiesEditor value={port.properties} onChange={(properties) => update(port, { properties })} />
    </div>
  );
}

/** The ports of a factory model, and the editor of the selected one. */
export function PortPanel() {
  const ports = useApp((s) => selectDocState(s).factory?.ports);
  const portUid = useFactorySelection((s) => s.portUid);
  const t = useT().factory.ports;
  const selected = ports?.find((p) => p.uid === portUid);
  // A selection that points at nothing (the port was removed or undone away) is dropped.
  useEffect(() => {
    if (portUid && ports && !selected) selectPort(null);
  }, [portUid, ports, selected]);
  if (!ports) return null;
  return (
    <div className="flex flex-col gap-3">
      <PortList ports={ports} selected={selected} />
      {selected ? (
        <>
          <SectionTitle>{selected.id}</SectionTitle>
          <PortEditor key={selected.uid} port={selected} />
        </>
      ) : (
        ports.length > 0 && <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.select}</p>
      )}
    </div>
  );
}
