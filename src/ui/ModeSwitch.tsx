import { selectDocState, useApp } from '../app/store';
import { elementModes, type ElementMode } from '../core/types';
import { runAction, shortcutLabel } from './actions';
import { elementLabels } from './labels';
import { Tip } from './Tip';

/** Element-mode glyphs: the same square with its corners, an edge or its face picked out. */
function ElementIcon({ mode }: { mode: ElementMode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor">
      <rect x="3.5" y="3.5" width="9" height="9" strokeWidth="1" opacity={mode === 'face' ? 1 : 0.55} fill={mode === 'face' ? 'currentColor' : 'none'} fillOpacity="0.85" />
      {mode === 'vertex' && [3.5, 12.5].flatMap((x) => [3.5, 12.5].map((y) => <rect key={`${x}-${y}`} x={x - 1.5} y={y - 1.5} width="3" height="3" fill="currentColor" stroke="none" />))}
      {mode === 'edge' && <path d="M3.5 3.5v9" strokeWidth="2.5" strokeLinecap="round" />}
    </svg>
  );
}

const group = 'flex items-center rounded-lg border border-line bg-panel/90 p-0.5 backdrop-blur-sm';
const segment = (active: boolean) =>
  `flex h-6 items-center rounded-md text-[12.5px] ${active ? 'bg-raised text-text shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim hover:text-text'}`;

/** Object/edit mode and, in edit mode, which kind of element is selected. Floats over the viewport. */
export function ModeSwitch() {
  const elementMode = useApp((s) => selectDocState(s).edit?.elementMode);
  const hasActive = useApp((s) => selectDocState(s).activeId !== null);
  const editing = elementMode !== undefined;
  const canEdit = editing || hasActive;
  const toggle = shortcutLabel('mode.toggle');
  return (
    <div className="absolute top-3 left-3 flex items-center gap-2">
      <div role="radiogroup" aria-label="Modus" className={group}>
        <Tip label="Objekte anordnen" shortcut={editing ? toggle : undefined}>
          <button role="radio" aria-checked={!editing} className={`${segment(!editing)} px-2.5`} onClick={() => editing && void runAction('mode.object')}>
            Objekt
          </button>
        </Tip>
        <Tip label={canEdit ? 'Netz des aktiven Objekts bearbeiten' : 'Wähle zuerst ein Objekt aus'} shortcut={!editing && canEdit ? toggle : undefined}>
          <button
            role="radio"
            aria-checked={editing}
            // Not `disabled`, so the tooltip can still say why.
            aria-disabled={!canEdit}
            className={`${segment(editing)} px-2.5 ${canEdit ? '' : 'cursor-default text-faint hover:text-faint'}`}
            onClick={() => canEdit && !editing && void runAction('mode.edit')}
          >
            Bearbeiten
          </button>
        </Tip>
      </div>
      {editing && (
        <div role="radiogroup" aria-label="Auswahlmodus" className={group}>
          {elementModes.map((mode) => {
            const active = mode === elementMode;
            return (
              <Tip key={mode} label={elementLabels[mode].title} shortcut={shortcutLabel(`element.${mode}`)}>
                <button
                  role="radio"
                  aria-checked={active}
                  aria-label={elementLabels[mode].title}
                  className={`${segment(active)} w-7 justify-center ${active ? 'text-accent!' : ''}`}
                  onClick={() => void runAction(`element.${mode}`)}
                >
                  <ElementIcon mode={mode} />
                </button>
              </Tip>
            );
          })}
        </div>
      )}
    </div>
  );
}
