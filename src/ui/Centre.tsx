import { memo } from 'react';
import { selectDocState, useApp } from '../app/store';
import type { Workspace } from '../core/types';
import { Viewport } from '../viewport/Viewport';
import { shortcutLabel } from './actions';
import { workspaceLabels } from './labels';
import { LastOpPanel } from './LastOpPanel';
import { ModeSwitch } from './ModeSwitch';

// Never re-rendered by UI state: it takes no props and its parent passes none.
const ViewportHost = memo(function ViewportHost() {
  return (
    <div className="absolute inset-0">
      <Viewport />
    </div>
  );
});

const Key = ({ children }: { children: string }) => (
  <kbd className="rounded-[5px] border border-line-strong bg-panel px-1.5 py-0.5 font-sans text-[12px] text-text">{children}</kbd>
);

function EmptyHint() {
  const empty = useApp((s) => selectDocState(s).order.length === 0);
  if (!empty) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center px-4">
      <p className="rounded-full border border-line bg-panel/85 px-4 py-2 text-[13px] text-dim backdrop-blur-sm">
        Die Szene ist leer. <Key>{shortcutLabel('add.menu')!}</Key> fügt ein Objekt hinzu, <Key>{shortcutLabel('palette.open')!}</Key> öffnet
        alle Befehle.
      </p>
    </div>
  );
}

const upcoming: Partial<Record<Workspace, { phase: string; text: string }>> = {
  uv: { phase: 'kommt in Phase 3', text: 'Hier wickelst du Netze ab und ordnest ihre UV-Inseln an.' },
  paint: { phase: 'kommt in Phase 4', text: 'Hier malst du Farbe und Material direkt auf das Modell.' },
};

function Placeholder({ workspace }: { workspace: Workspace }) {
  const info = upcoming[workspace];
  if (!info) return null;
  const { title, icon: Icon } = workspaceLabels[workspace];
  return (
    <div className="dot-grid absolute inset-0 flex items-center justify-center bg-ink p-6">
      <div className="flex max-w-xs flex-col items-center text-center">
        <Icon size={28} strokeWidth={1.25} className="text-faint" />
        <h2 className="mt-4 font-display text-[22px] leading-tight font-semibold text-text">{title}</h2>
        <p className="mt-1 text-[13px] text-accent">{info.phase}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-dim">{info.text} Bis dahin findest du alles Fertige unter Modellieren.</p>
      </div>
    </div>
  );
}

export function Centre() {
  const workspace = useApp((s) => s.workspace);
  return (
    <main className="relative min-h-0 min-w-0 overflow-hidden bg-ink">
      {/* The viewport stays mounted in every workspace so its camera and the screenshot service survive. */}
      <ViewportHost />
      {workspace === 'modeling' ? (
        <>
          <EmptyHint />
          <ModeSwitch />
          <LastOpPanel />
        </>
      ) : (
        <Placeholder workspace={workspace} />
      )}
    </main>
  );
}
