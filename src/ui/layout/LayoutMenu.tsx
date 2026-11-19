import { Menu } from '@base-ui/react/menu';
import { Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../../i18n';
import { shortcutLabel } from '../actions';
import { itemClass, MenuSeparator, Submenu } from '../menu';
import { inputClass, primaryButton, ProjectDialog, quietButton } from '../projects/dialogParts';
import { usePanelContext } from './Dock';
import { applyLayout, cleanName, deleteLayout, MAX_NAME_LENGTH, resetLayout, saveLayout, togglePanel, useLayout } from './layoutStore';
import { isPanelOpen } from './model';
import { isShown, usePanelRegistry } from './registry';

// View > Panels and View > Layouts, and the dialog that saves and deletes named layouts.

const indicator = (
  <span className="flex w-4 shrink-0 justify-center">
    <Menu.CheckboxItemIndicator>
      <Check size={14} strokeWidth={2.25} />
    </Menu.CheckboxItemIndicator>
  </span>
);

/** The panels that have something to show here, checked when open; choosing one shows or hides it. */
function PanelItems() {
  const defs = usePanelRegistry((s) => s.panels);
  const layout = useLayout((s) => s.layout);
  const context = usePanelContext();
  const t = useT();
  const panels = [...defs].filter((d) => isShown(d, context)).sort((a, b) => a.order - b.order);
  return panels.map((panel) => {
    const shortcut = panel.shortcutAction ? shortcutLabel(panel.shortcutAction) : undefined;
    return (
      <Menu.CheckboxItem key={panel.id} className={itemClass} checked={isPanelOpen(layout, panel.id)} closeOnClick onCheckedChange={() => togglePanel(panel.id)}>
        {indicator}
        <span>{panel.title(t)}</span>
        {shortcut && <span className="tnum ml-auto pl-6 text-[calc(12px*var(--font-scale))] opacity-60">{shortcut}</span>}
      </Menu.CheckboxItem>
    );
  });
}

function LayoutItems() {
  const saved = useLayout((s) => s.saved);
  const current = useLayout((s) => s.current);
  const t = useT();
  const names = Object.keys(saved).sort((a, b) => a.localeCompare(b));
  return (
    <>
      {names.length > 0 && (
        <>
          <Menu.RadioGroup value={current ?? ''}>
            {names.map((name) => (
              <Menu.RadioItem key={name} value={name} className={itemClass} closeOnClick onClick={() => applyLayout(name)}>
                <span className="flex w-4 shrink-0 justify-center">
                  <Menu.RadioItemIndicator>
                    <Check size={14} strokeWidth={2.25} />
                  </Menu.RadioItemIndicator>
                </span>
                <span className="truncate">{name}</span>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <MenuSeparator />
        </>
      )}
      <Menu.Item className={itemClass} onClick={() => useLayout.setState({ manageOpen: true })}>
        <span className="w-4 shrink-0" />
        <span>{t.layout.manage}</span>
      </Menu.Item>
      <Menu.Item className={itemClass} onClick={resetLayout}>
        <span className="w-4 shrink-0" />
        <span>{t.layout.reset}</span>
      </Menu.Item>
    </>
  );
}

/** The Panels and Layouts submenus of the View menu. */
export function LayoutMenuItems() {
  const t = useT();
  return (
    <>
      <Submenu title={t.layout.panels}>
        <PanelItems />
      </Submenu>
      <Submenu title={t.layout.layouts}>
        <LayoutItems />
      </Submenu>
    </>
  );
}

function LayoutsDialogBody({ onClose }: { onClose(): void }) {
  const saved = useLayout((s) => s.saved);
  const current = useLayout((s) => s.current);
  const t = useT();
  const [name, setName] = useState(current ?? '');
  const clean = cleanName(name);
  const names = Object.keys(saved).sort((a, b) => a.localeCompare(b));
  const save = () => {
    if (!clean) return;
    saveLayout(clean);
    onClose();
  };
  return (
    <>
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label htmlFor="layout-name" className="text-[calc(12.5px*var(--font-scale))] text-dim">
          {t.layout.saveCurrent}
        </label>
        <div className="flex gap-2">
          <input
            id="layout-name"
            autoFocus
            maxLength={MAX_NAME_LENGTH}
            spellCheck={false}
            className={inputClass}
            placeholder={t.layout.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <button type="submit" className={primaryButton} disabled={!clean}>
            {saved[clean] ? t.layout.replace : t.layout.save}
          </button>
        </div>
      </form>
      <div className="flex flex-col gap-1">
        <h3 className="text-[calc(12.5px*var(--font-scale))] text-dim">{t.layout.savedLayouts}</h3>
        {names.length === 0 ? (
          <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.layout.noneSaved}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {names.map((entry) => (
              <li key={entry} className="flex items-center gap-2 rounded-md py-0.5 pr-0.5 pl-2.5 hover:bg-raised">
                <span className="flex-1 truncate text-[calc(13px*var(--font-scale))] text-text">
                  {entry}
                  {entry === current && <span className="ml-2 text-faint">{t.layout.active}</span>}
                </span>
                <button
                  type="button"
                  className={quietButton}
                  onClick={() => {
                    applyLayout(entry);
                    onClose();
                  }}
                >
                  {t.layout.apply}
                </button>
                <button
                  type="button"
                  aria-label={t.layout.deleteNamed(entry)}
                  className="flex size-8 items-center justify-center rounded-md text-dim hover:bg-danger/12 hover:text-danger"
                  onClick={() => deleteLayout(entry)}
                >
                  <Trash2 size={15} strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Saves the current layout under a name, and applies or deletes saved ones. */
export function LayoutsDialog() {
  const open = useLayout((s) => s.manageOpen);
  const t = useT();
  const close = () => useLayout.setState({ manageOpen: false });
  return (
    <ProjectDialog open={open} onClose={close} title={t.layout.manageTitle}>
      {open && <LayoutsDialogBody onClose={close} />}
    </ProjectDialog>
  );
}
