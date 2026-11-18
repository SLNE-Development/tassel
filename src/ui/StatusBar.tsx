import { Menu } from '@base-ui/react/menu';
import { useEffect, useMemo, useState } from 'react';
import { selectDocState, useApp } from '../app/store';
import { getMcpStatus, type McpStatus } from '../bridge/mcp';
import { meshStats } from '../core/mesh/polymesh';
import type { EditState, PolyMesh } from '../core/types';
import { elementLabels } from './labels';
import { itemClass, popupClass } from './menu';
import { notifyError, notifySuccess } from './toast';
import { Tip } from './Tip';

const count = (n: number, one: string, many: string) => `${n.toLocaleString('de-DE')} ${n === 1 ? one : many}`;

function Selection() {
  const selected = useApp((s) => selectDocState(s).selection.length);
  const activeName = useApp((s) => {
    const state = selectDocState(s);
    return state.activeId ? state.objects[state.activeId]?.name : undefined;
  });
  if (selected === 0) return <span className="text-faint">Nichts ausgewählt</span>;
  return (
    <span className="min-w-0 truncate">
      <span className="text-text">{activeName}</span>
      {selected > 1 && <span className="text-dim"> und {count(selected - 1, 'weiteres', 'weitere')}</span>}
    </span>
  );
}

/** Number of selected and existing elements of the current element mode. */
export function elementCounts(edit: EditState, mesh: PolyMesh): { selected: number; total: number } {
  if (edit.elementMode === 'vertex') return { selected: edit.vertices.length, total: mesh.positions.length / 3 };
  if (edit.elementMode === 'edge') return { selected: edit.edges.length, total: meshStats(mesh).edges };
  return { selected: edit.faces.length, total: mesh.faces.length };
}

function Mode() {
  const edit = useApp((s) => selectDocState(s).edit);
  const mesh = useApp((s) => {
    const state = selectDocState(s);
    return state.edit ? state.objects[state.edit.objectId]?.mesh : undefined;
  });
  const name = useApp((s) => {
    const state = selectDocState(s);
    return state.edit ? state.objects[state.edit.objectId]?.name : undefined;
  });
  const counts = useMemo(() => (edit && mesh ? elementCounts(edit, mesh) : null), [edit, mesh]);
  if (!edit || !counts) {
    return (
      <>
        <span className="shrink-0 text-dim">Objektmodus</span>
        <div aria-hidden className="h-3 w-px shrink-0 bg-line-strong" />
        <Selection />
      </>
    );
  }
  return (
    <>
      <span className="shrink-0 text-accent">Bearbeitungsmodus</span>
      <div aria-hidden className="h-3 w-px shrink-0 bg-line-strong" />
      <span className="min-w-0 truncate">
        <span className="text-text">{name}</span>
        <span className="tnum text-dim">
          {' – '}
          {counts.selected.toLocaleString('de-DE')} von {counts.total.toLocaleString('de-DE')} {elementLabels[edit.elementMode].of(counts.total)} ausgewählt
        </span>
      </span>
    </>
  );
}

function Totals() {
  const objects = useApp((s) => selectDocState(s).objects);
  const totals = useMemo(() => {
    let vertices = 0;
    let faces = 0;
    const list = Object.values(objects);
    for (const obj of list) {
      vertices += obj.mesh.positions.length / 3;
      faces += obj.mesh.faces.length;
    }
    return { objects: list.length, vertices, faces };
  }, [objects]);
  return (
    <div className="tnum flex shrink-0 gap-4 text-dim">
      <span>{count(totals.objects, 'Objekt', 'Objekte')}</span>
      <span>{count(totals.vertices, 'Eckpunkt', 'Eckpunkte')}</span>
      <span>{count(totals.faces, 'Fläche', 'Flächen')}</span>
    </div>
  );
}

function Mcp() {
  // undefined = not asked yet, null = not running in the desktop app.
  const [status, setStatus] = useState<McpStatus | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      getMcpStatus()
        .then((next) => alive && setStatus(next))
        .catch((error) => alive && setStatus({ running: false, url: '', token: '', error: String(error?.message ?? error) }));
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (status === undefined) return <span className="w-40" />;
  if (status === null) {
    return (
      <span className="flex shrink-0 items-center gap-2 text-faint">
        <span aria-hidden className="size-1.5 rounded-full bg-line-strong" />
        MCP nur in der Desktop-App
      </span>
    );
  }

  const state = status.running ? 'läuft' : status.error ? 'Fehler' : 'gestoppt';
  const dot = status.running ? 'bg-ok' : status.error ? 'bg-danger' : 'bg-faint';
  const header = `Authorization: Bearer ${status.token}`;
  // What an MCP client needs to connect: the server requires the token on every request.
  const copies = [
    {
      label: 'Befehl für Claude Code kopieren',
      text: `claude mcp add --transport http tessel ${status.url} --header "${header}"`,
    },
    {
      label: 'JSON-Konfiguration kopieren',
      text: JSON.stringify(
        { mcpServers: { tessel: { type: 'http', url: status.url, headers: { Authorization: `Bearer ${status.token}` } } } },
        null,
        2,
      ),
    },
    { label: 'Adresse kopieren', text: status.url },
    { label: 'Zugriffstoken kopieren', text: status.token },
  ];
  const copy = (label: string, text: string) =>
    navigator.clipboard.writeText(text).then(() => notifySuccess('In die Zwischenablage kopiert', label), notifyError);

  return (
    <Menu.Root>
      <Tip label={status.error ?? (status.running ? 'KI-Client verbinden' : 'MCP-Server läuft nicht')} side="top">
        <Menu.Trigger
          className="tnum flex h-5 shrink-0 items-center gap-2 rounded px-1.5 text-dim hover:bg-raised hover:text-text disabled:pointer-events-none"
          disabled={!status.url}
          aria-label={`MCP ${state}${status.url ? `, ${status.url}` : ''}`}
        >
          <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
          <span>MCP</span>
          <span className="text-faint">{status.url || state}</span>
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="end" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>
            {copies.map(({ label, text }) => (
              <Menu.Item key={label} className={itemClass} onClick={() => void copy(label, text)}>
                {label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function StatusBar() {
  return (
    <footer className="flex h-6.5 items-center gap-3 border-t border-line bg-panel pr-2 pl-3 text-[12px]">
      <Mode />
      <div className="flex-1" />
      <Totals />
      <div aria-hidden className="h-3 w-px shrink-0 bg-line-strong" />
      <Mcp />
    </footer>
  );
}
