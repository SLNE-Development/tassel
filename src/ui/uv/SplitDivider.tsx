import type { KeyboardEvent, PointerEvent } from 'react';
import { useT } from '../../i18n';
import { useUvUi } from './uvStore';

/** Neither side gets narrower than this (CSS px), as long as the centre is wide enough for both. */
const MIN_PANE = 200;

function setSplit(ratio: number, width: number): void {
  const min = Math.min(0.45, MIN_PANE / width);
  useUvUi.setState({ split: Math.min(1 - min, Math.max(min, ratio)) });
}

/** The draggable border between the UV editor and the 3D viewport. Positioned inside the centre, which it measures. */
export function SplitDivider() {
  const split = useUvUi((s) => s.split);
  const t = useT();

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    setSplit((event.clientX - rect.left) / rect.width, rect.width);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0;
    if (!step) return;
    event.preventDefault();
    setSplit(split + step, event.currentTarget.parentElement!.getBoundingClientRect().width);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t.uv.divider}
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      className="group absolute inset-y-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize touch-none justify-center outline-none"
      style={{ left: `${split * 100}%` }}
      onPointerDown={(event) => event.button === 0 && event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={onPointerMove}
      onDoubleClick={() => useUvUi.setState({ split: 0.5 })}
      onKeyDown={onKeyDown}
    >
      <div className="h-full w-px bg-line group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent group-active:w-0.5 group-active:bg-accent" />
    </div>
  );
}
