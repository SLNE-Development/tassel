import { selectPort, useFactorySelection } from '../../app/factorySelection';
import { selectDocState, useApp } from '../../app/store';
import { useT } from '../../i18n';
import { KindDot } from './KindDot';

/** A compact list of the ports of a factory model below the object tree; a click selects the port (its marker lights up in the viewport). */
export function PortOutliner() {
  const ports = useApp((s) => selectDocState(s).factory?.ports);
  const portUid = useFactorySelection((s) => s.portUid);
  const t = useT();
  if (!ports) return null;
  return (
    <section aria-label={t.factory.outliner.ports} className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-line">
      <header className="flex h-8 shrink-0 items-center justify-between pr-3 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.factory.outliner.ports}</h2>
        <span className="tnum text-[calc(12px*var(--font-scale))] text-faint">{ports.length || ''}</span>
      </header>
      <ul className="mx-1.5 mb-2 flex min-h-0 flex-col gap-px overflow-y-auto">
        {ports.map((port) => (
          <li key={port.uid}>
            <button
              type="button"
              aria-pressed={port.uid === portUid}
              className={`flex h-6 w-full items-center gap-2 rounded-md px-2 text-left text-[calc(12.5px*var(--font-scale))] ${
                port.uid === portUid ? 'bg-raised text-text' : 'text-dim hover:bg-raised hover:text-text'
              }`}
              onClick={() => selectPort(port.uid)}
            >
              <KindDot port={port} />
              <span className="min-w-0 flex-1 truncate">{port.id}</span>
              <span className="shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{port.face ? t.mc.faces[port.face] : t.factory.ports.noFace}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
