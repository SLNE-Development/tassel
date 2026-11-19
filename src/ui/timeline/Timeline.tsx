import { Menu } from '@base-ui/react/menu';
import { Check, Clapperboard, Diamond, DiamondMinus, DiamondPlus, Maximize2, Pause, Play, Repeat, SkipBack, SkipForward, Spline, StepBack, StepForward, Video, X, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { animationRange, frameOf, pause, setFrame, setTimelineOpen, usePlayback } from '../../app/playback';
import { onAppearanceChange } from '../../app/preferences';
import { execute, selectDocState, useApp } from '../../app/store';
import { DEFAULT_FPS, DEFAULT_FRAME_COUNT, MAX_FPS, MAX_FRAME_COUNT, MAX_KEY_FRAME } from '../../core/animation';
import { formatSeconds, trackChannels } from '../../core/playhead';
import { own } from '../../core/state';
import { keyInterpolations } from '../../core/types';
import { useT } from '../../i18n';
import { runAction, shortcutLabel } from '../actions';
import { itemClass, popupClass } from '../menu';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { notifyError } from '../toast';
import { CAMERA_ROW, keyInterpolation, selectedKey, setKeyInterpolation, useTimeline } from './timelineActions';
import { PAD, ROW_HEIGHT, RULER_HEIGHT, drawRows, drawRuler, keyNear, readPalette, xFrame, type Palette, type Row, type Scale } from './tracksCanvas';

const LABEL_WIDTH = 132;
/** Rows in view before the list scrolls. */
const VISIBLE_ROWS = 4;

const iconButton = (active = false) =>
  `flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-[calc(12.5px*var(--font-scale))] disabled:pointer-events-none disabled:text-faint/50 ${
    active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'
  }`;

/** A timeline button bound to a UI action: tooltip, shortcut and behaviour come from the action. */
function ActionButton({ id, label, icon: Icon, active, disabled, text }: { id: string; label: string; icon: LucideIcon; active?: boolean; disabled?: boolean; text?: boolean }) {
  return (
    <Tip label={label} shortcut={shortcutLabel(id)} side="top">
      <button aria-label={label} aria-pressed={active} disabled={disabled} className={iconButton(active)} onClick={() => void runAction(id)}>
        <Icon size={15} strokeWidth={1.75} />
        {/* The words only where the dock is wide enough for them. */}
        {text && <span className="hidden pr-0.5 @[70rem]:inline">{label}</span>}
      </button>
    </Tip>
  );
}

const Divider = () => <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong" />;

function Transport() {
  const t = useT().timeline;
  const playing = usePlayback((s) => s.playing !== null);
  const loop = usePlayback((s) => s.loop);
  const editing = useApp((s) => selectDocState(s).edit !== null);
  return (
    <div role="group" aria-label={t.title} className="flex items-center">
      <ActionButton id="timeline.start" label={t.toStart} icon={SkipBack} />
      <ActionButton id="timeline.previous_key" label={t.previousKey} icon={StepBack} disabled={editing} />
      <ActionButton id="timeline.play" label={playing ? t.pause : t.play} icon={playing ? Pause : Play} active={playing} disabled={editing} />
      <ActionButton id="timeline.next_key" label={t.nextKey} icon={StepForward} disabled={editing} />
      <ActionButton id="timeline.end" label={t.toEnd} icon={SkipForward} />
      <Tip label={t.loop} side="top">
        <button aria-label={t.loop} aria-pressed={loop} className={iconButton(loop)} onClick={() => usePlayback.setState({ loop: !loop })}>
          <Repeat size={15} strokeWidth={1.75} />
        </button>
      </Tip>
    </div>
  );
}

/** Current frame (editable, scrubbable) and its time. */
function Readout() {
  const t = useT();
  const docId = useApp((s) => s.activeDocId);
  const animation = useApp((s) => selectDocState(s).animation);
  const frame = usePlayback((s) => frameOf(docId, s));
  const fps = animation?.fps ?? DEFAULT_FPS;
  const frameCount = animation?.frameCount ?? DEFAULT_FRAME_COUNT;
  const go = (value: number) => {
    pause();
    setFrame(value);
  };
  return (
    <div className="flex items-center gap-2">
      <div className="w-[6.25rem]">
        <ScrubField wide label={t.timeline.frame} ariaLabel={t.timeline.frame} color="var(--dim)" value={frame} step={0.2} integer min={0} max={frameCount - 1} onCommit={go} onScrub={go} />
      </div>
      <span className="tnum w-[4.25rem] shrink-0 text-[calc(12.5px*var(--font-scale))] text-dim" aria-live="off">
        {formatSeconds(frame / fps, t.locale)} s
      </span>
    </div>
  );
}

function RangeFields() {
  const t = useT().timeline;
  const animation = useApp((s) => selectDocState(s).animation);
  const set = (params: { fps?: number; frameCount?: number }) => void execute('anim.set_range', params).catch(notifyError);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-[4.75rem]">
        <ScrubField wide label={t.fps} ariaLabel={t.fps} color="var(--dim)" value={animation?.fps ?? DEFAULT_FPS} step={0.1} min={1} max={MAX_FPS} onCommit={(fps) => set({ fps })} />
      </div>
      <div className="w-[6.75rem]">
        <ScrubField wide label={t.length} ariaLabel={t.length} color="var(--dim)" value={animation?.frameCount ?? DEFAULT_FRAME_COUNT} step={0.5} integer min={1} max={MAX_FRAME_COUNT} onCommit={(frameCount) => set({ frameCount })} />
      </div>
    </div>
  );
}

/** How the value travels on from the picked key. */
function InterpolationMenu() {
  const t = useT().timeline;
  const state = useApp(selectDocState);
  const picked = useTimeline((s) => s.selectedKey);
  const key = picked ? selectedKey(state) : null;
  const current = key ? keyInterpolation(state, key) : null;
  return (
    <Menu.Root>
      <Tip label={t.interpolation} side="top">
        <Menu.Trigger aria-label={t.interpolation} disabled={current === null} className={`${iconButton()} data-[popup-open]:bg-raised data-[popup-open]:text-text`}>
          <Spline size={15} strokeWidth={1.75} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Menu.Popup className={popupClass}>
            <Menu.RadioGroup value={current ?? ''}>
              {keyInterpolations.map((mode) => (
                <Menu.RadioItem key={mode} value={mode} closeOnClick className={itemClass} onClick={() => void Promise.resolve(setKeyInterpolation(mode)).catch(notifyError)}>
                  <span className="flex w-4 shrink-0 justify-center">
                    <Menu.RadioItemIndicator>
                      <Check size={14} strokeWidth={2.25} />
                    </Menu.RadioItemIndicator>
                  </span>
                  <span>{t.interpolations[mode]}</span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Header() {
  const t = useT().timeline;
  const cameraView = usePlayback((s) => s.cameraView);
  return (
    <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-line px-1.5 py-1">
      <Transport />
      <Divider />
      <Readout />
      <Divider />
      <ActionButton id="timeline.set_key" label={t.setKey} icon={DiamondPlus} text />
      <ActionButton id="timeline.delete_key" label={t.deleteKey} icon={DiamondMinus} />
      <InterpolationMenu />
      <Divider />
      <ActionButton id="timeline.set_camera_key" label={t.setCameraKey} icon={Diamond} text />
      <ActionButton id="timeline.camera_view" label={t.cameraView} icon={Video} active={cameraView} />
      <div className="ml-auto flex items-center gap-1">
        <RangeFields />
        <Divider />
        <ActionButton id="video.export" label={t.exportVideo} icon={Clapperboard} text />
        <ActionButton id="timeline.toggle" label={t.close} icon={X} />
      </div>
    </header>
  );
}

/** The ruler and the key rows of the selection. */
function Tracks() {
  const t = useT().timeline;
  const docId = useApp((s) => s.activeDocId);
  const state = useApp(selectDocState);
  const frame = usePlayback((s) => frameOf(docId, s));
  const fontScale = useApp((s) => s.preferences.fontScale ?? 1);
  const picked = useTimeline((s) => s.selectedKey);
  const { animation, selection, objects } = state;
  const frameCount = animation?.frameCount ?? DEFAULT_FRAME_COUNT;

  const rows = useMemo((): Row[] => {
    const list: Row[] = [{ id: CAMERA_ROW, label: t.cameraRow, lists: animation && animation.camera.length > 0 ? [animation.camera] : [] }];
    for (const id of selection) {
      const object = own(objects, id);
      if (object) list.push({ id, label: object.name, lists: trackChannels(animation ? own(animation.tracks, id) : undefined) });
    }
    return list;
  }, [animation, selection, objects, t.cameraRow]);
  const hasKeys = animation !== undefined && (animation.camera.length > 0 || Object.keys(animation.tracks).length > 0);

  // The frames in view; null shows the whole animation.
  const [zoom, setZoom] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => setZoom(null), [docId]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [drag, setDrag] = useState<{ row: string; from: number; to: number } | null>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const read = () => setPalette(readPalette());
    read();
    // The tokens are applied to the document a moment after the preference changes.
    return onAppearanceChange(() => requestAnimationFrame(read));
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setSize({ width: Math.max(0, element.clientWidth - LABEL_WIDTH), height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const scale: Scale = useMemo(() => ({ start: zoom?.start ?? 0, end: zoom?.end ?? Math.max(1, frameCount - 1), width: Math.max(size.width, 2 * PAD + 1) }), [zoom, frameCount, size.width]);

  useEffect(() => {
    if (!palette || size.width === 0) return;
    if (ruler.current) drawRuler(ruler.current, scale, frameCount, frame, fontScale, palette);
    if (canvas.current) drawRows(canvas.current, scale, { rows, scrollTop, height: size.height, frameCount, playhead: frame, selected: picked, drag }, palette);
  }, [palette, scale, size, rows, scrollTop, frameCount, frame, fontScale, picked, drag]);

  // Ctrl + wheel (or the wheel over the ruler) zooms about the pointer, Shift + wheel moves along the time.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const overRuler = event.currentTarget === ruler.current;
      if (!overRuler && !event.ctrlKey && !event.shiftKey) return;
      event.preventDefault();
      const s = scaleRef.current;
      const span = s.end - s.start;
      const limit = Math.max(animationRange(useApp.getState().activeDocId).frameCount - 1, 1) * 1.5 + 10;
      if (event.shiftKey && !event.ctrlKey) {
        const shift = ((event.deltaY || event.deltaX) / 100) * span * 0.15;
        const start = Math.max(-span * 0.2, Math.min(s.start + shift, limit - span));
        setZoom({ start, end: start + span });
        return;
      }
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const at = xFrame(s, event.clientX - rect.left);
      const next = Math.min(limit, Math.max(4, span * Math.exp(event.deltaY * 0.0015)));
      const start = at - ((at - s.start) / span) * next;
      setZoom({ start, end: start + next });
    };
    const targets = [ruler.current, canvas.current].filter((e): e is HTMLCanvasElement => e !== null);
    for (const target of targets) target.addEventListener('wheel', onWheel, { passive: false });
    return () => targets.forEach((target) => target.removeEventListener('wheel', onWheel));
  }, []);

  const frameAt = (event: ReactPointerEvent<HTMLCanvasElement>) => Math.round(xFrame(scale, event.clientX - event.currentTarget.getBoundingClientRect().left));

  const scrubbing = useRef(false);
  const scrub = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    pause();
    setFrame(frameAt(event));
  };
  const endPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    scrubbing.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onRulerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubbing.current = true;
    scrub(event);
  };

  const onRowsDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    const row = rows[Math.floor((event.clientY - rect.top + scrollTop) / ROW_HEIGHT)];
    const key = row ? keyNear(row, scale, event.clientX - rect.left, 7) : null;
    if (row && key !== null) {
      // A key: pick it, show its frame, and let it be dragged to another one.
      useTimeline.setState({ selectedKey: { row: row.id, frame: key } });
      pause();
      setFrame(key);
      setDrag({ row: row.id, from: key, to: key });
      return;
    }
    useTimeline.setState({ selectedKey: null });
    scrubbing.current = true;
    scrub(event);
  };

  const onRowsMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (drag) {
      const to = Math.min(MAX_KEY_FRAME, Math.max(0, frameAt(event)));
      if (to !== drag.to) setDrag({ ...drag, to });
    } else if (scrubbing.current) scrub(event);
  };

  const onRowsUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    endPointer(event);
    const moved = drag;
    setDrag(null);
    if (!moved || moved.to === moved.from) return;
    const target = moved.row === CAMERA_ROW ? { camera: true } : { ids: [moved.row] };
    // One command, so one undo step; the key stays picked on its new frame.
    execute('anim.move_key', { ...target, frame: moved.from, toFrame: moved.to })
      .then(() => {
        useTimeline.setState({ selectedKey: { row: moved.row, frame: moved.to } });
        setFrame(moved.to);
      })
      .catch(notifyError);
  };

  const firstRow = Math.floor(scrollTop / ROW_HEIGHT);
  const visible = rows.slice(firstRow, firstRow + Math.ceil((size.height || VISIBLE_ROWS * ROW_HEIGHT) / ROW_HEIGHT) + 1);

  return (
    <div className="relative flex min-h-0 flex-col">
      <div className="flex shrink-0 border-b border-line" style={{ height: RULER_HEIGHT }}>
        <div className="flex shrink-0 items-center justify-end pr-1" style={{ width: LABEL_WIDTH }}>
          {zoom && (
            <Tip label={t.fit} side="top">
              <button aria-label={t.fit} className="flex size-5 items-center justify-center rounded text-faint hover:bg-raised hover:text-text" onClick={() => setZoom(null)}>
                <Maximize2 size={12} strokeWidth={1.75} />
              </button>
            </Tip>
          )}
        </div>
        <canvas
          ref={ruler}
          role="img"
          aria-label={t.ruler}
          className="block cursor-ew-resize touch-none"
          style={{ width: scale.width, height: RULER_HEIGHT }}
          onPointerDown={onRulerDown}
          onPointerMove={(event) => scrubbing.current && scrub(event)}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onDoubleClick={() => setZoom(null)}
        />
      </div>
      <div ref={scroller} className="relative overflow-x-hidden overflow-y-auto" style={{ height: VISIBLE_ROWS * ROW_HEIGHT }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
        <div className="relative" style={{ height: Math.max(rows.length * ROW_HEIGHT, size.height) }}>
          <canvas
            ref={canvas}
            role="img"
            aria-label={t.keys}
            className="sticky top-0 block touch-none"
            style={{ marginLeft: LABEL_WIDTH, width: scale.width, height: size.height }}
            onPointerDown={onRowsDown}
            onPointerMove={onRowsMove}
            onPointerUp={onRowsUp}
            onPointerCancel={(event) => {
              endPointer(event);
              setDrag(null);
            }}
          />
          {visible.map((row, i) => (
            <div
              key={row.id}
              className="absolute left-0 flex items-center gap-1.5 border-b border-line pr-2 pl-2.5 text-[calc(12px*var(--font-scale))] text-dim"
              style={{ top: (firstRow + i) * ROW_HEIGHT, height: ROW_HEIGHT, width: LABEL_WIDTH }}
            >
              {row.id === CAMERA_ROW && <Video size={12} strokeWidth={1.75} className="shrink-0 text-faint" />}
              <span className={`min-w-0 truncate ${row.lists.length > 0 ? 'text-text' : ''}`}>{row.label}</span>
            </div>
          ))}
        </div>
      </div>
      {!hasKeys && (
        <p className="pointer-events-none absolute right-3 bottom-2 max-w-[calc(100%-9.5rem)] truncate rounded-md bg-panel/90 px-2 py-0.5 text-[calc(12px*var(--font-scale))] text-faint" style={{ left: LABEL_WIDTH + 8 }}>
          {t.empty}
        </p>
      )}
    </div>
  );
}

/** The timeline: a dock under the viewport, toggled from the view menu. */
export function TimelineDock() {
  const open = usePlayback((s) => s.timelineOpen);
  const t = useT().timeline;
  if (!open) return null;
  return (
    <section aria-label={t.title} className="@container flex shrink-0 flex-col border-t border-line-strong bg-panel">
      <Header />
      <Tracks />
    </section>
  );
}

/** Shown over the viewport while it looks through the animated camera: says so, and leads back. */
export function CameraViewBadge(): ReactNode {
  const t = useT().timeline;
  const active = usePlayback((s) => s.cameraView);
  const possible = useApp((s) => {
    const state = selectDocState(s);
    return !state.edit && s.workspace !== 'paint' && (state.animation?.camera.length ?? 0) > 0;
  });
  if (!active || !possible) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
      <div className="pointer-events-auto flex h-7 items-center gap-1.5 rounded-full border border-accent/60 bg-overlay/95 pr-1 pl-2.5 text-[calc(12px*var(--font-scale))] text-text shadow-pop backdrop-blur-sm">
        <Video size={13} strokeWidth={1.75} className="text-accent" />
        {t.cameraView}
        <Tip label={t.leaveCameraView} shortcut={shortcutLabel('timeline.camera_view')}>
          <button aria-label={t.leaveCameraView} className="flex size-5 items-center justify-center rounded-full text-dim hover:bg-raised hover:text-text" onClick={() => usePlayback.setState({ cameraView: false })}>
            <X size={12} strokeWidth={2} />
          </button>
        </Tip>
      </div>
    </div>
  );
}
