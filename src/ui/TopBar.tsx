import { useApp } from '../app/store';
import { workspaces } from '../core/types';
import { useT } from '../i18n';
import { dispatch } from './actions';
import { DocTabs } from './DocTabs';
import { useIsMinecraft } from './format';
import { MenuBar } from './MenuBar';
import { dragWindow, WindowControls } from './WindowControls';

/** The Tessel mark: a cube tessellated into three facets, the top one in the accent colour. */
function Mark() {
  return (
    <svg width="18" height="18" viewBox="0 0 64 64" aria-hidden strokeWidth="2" strokeLinejoin="round">
      <polygon points="32,7.82 51.36,19 32,30.18 12.64,19" fill="var(--accent)" stroke="var(--accent)" />
      <polygon points="11.06,21.73 30.42,32.91 30.42,55.27 11.06,44.09" fill="var(--text)" stroke="var(--text)" />
      <polygon points="52.94,21.73 52.94,44.09 33.58,55.27 33.58,32.91" fill="var(--dim)" stroke="var(--dim)" />
    </svg>
  );
}

function WorkspaceSwitch() {
  const workspace = useApp((s) => s.workspace);
  const t = useT();
  // Minecraft documents paint pixel art in the paint workspace; only they have the display workspace.
  const minecraft = useIsMinecraft();
  const shown = workspaces.filter((w) => minecraft || w !== 'display');
  return (
    <div role="radiogroup" aria-label={t.topBar.workspace} className="flex shrink-0 items-center rounded-lg bg-ink p-0.5">
      {shown.map((w) => {
        const active = w === workspace;
        return (
          <button
            key={w}
            role="radio"
            aria-checked={active}
            className={`h-6 rounded-md px-3 text-[calc(12.5px*var(--font-scale))] ${
              active ? 'bg-raised text-text shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim hover:text-text'
            }`}
            onClick={() => void dispatch('app.set_workspace', { workspace: w })}
          >
            {t.workspaces[w]}
          </button>
        );
      })}
    </div>
  );
}

export function TopBar() {
  return (
    <header className="flex h-10 items-center gap-2 border-b border-line bg-panel pl-3" onMouseDown={dragWindow}>
      <div className="flex shrink-0 items-center gap-2 pr-1">
        <Mark />
        <span className="font-display text-[calc(14px*var(--font-scale))] font-semibold tracking-[0.01em]">Tessel</span>
      </div>
      <MenuBar />
      <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong" />
      <DocTabs />
      <WorkspaceSwitch />
      <WindowControls />
    </header>
  );
}
