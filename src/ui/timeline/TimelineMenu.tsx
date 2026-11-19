import { Menu } from '@base-ui/react/menu';
import { Check } from 'lucide-react';
import { usePlayback } from '../../app/playback';
import { useT } from '../../i18n';
import { getAction, runAction, shortcutLabel } from '../actions';
import { itemClass } from '../menu';

/** A menu entry with a tick for something that is on or off. */
function ToggleItem({ id, checked }: { id: string; checked: boolean }) {
  useT(); // The action's title and shortcut label follow the UI language.
  const label = shortcutLabel(id);
  return (
    <Menu.CheckboxItem className={itemClass} checked={checked} onClick={() => void runAction(id)}>
      <span className="flex w-4 shrink-0 justify-center">
        <Menu.CheckboxItemIndicator>
          <Check size={14} strokeWidth={2.25} />
        </Menu.CheckboxItemIndicator>
      </span>
      <span>{getAction(id).title}</span>
      {label && <span className="tnum ml-auto pl-6 text-[calc(12px*var(--font-scale))] opacity-60">{label}</span>}
    </Menu.CheckboxItem>
  );
}

/** The timeline's entries of the view menu. */
export function TimelineItems() {
  const open = usePlayback((s) => s.timelineOpen);
  const cameraView = usePlayback((s) => s.cameraView);
  return (
    <>
      <ToggleItem id="timeline.toggle" checked={open} />
      <ToggleItem id="timeline.camera_view" checked={cameraView} />
    </>
  );
}
