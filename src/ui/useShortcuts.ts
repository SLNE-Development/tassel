import { useEffect } from 'react';
import { matchShortcut, runAction } from './actions';

const typingSelector = 'input, textarea, select, [contenteditable="true"]';
// Open menus and dialogs handle their own keys (typeahead, arrows, Enter).
const widgetSelector = '[role="menu"], [role="dialog"], [role="alertdialog"]';

/** Global keyboard shortcuts. The bindings themselves live in `actions.ts`. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = matchShortcut(event);
      if (!action) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!action.inInputs && (target?.closest(typingSelector) || target?.closest(widgetSelector))) return;
      if (event.repeat && !action.id.startsWith('edit.')) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      void runAction(action.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
