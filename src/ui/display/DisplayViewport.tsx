import { Move3d, RefreshCcw, Rotate3d, Scale3d } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { DisplayView, type DisplayOverlay, type GizmoMode } from '../../viewport/display/DisplayView';
import { useLiveEdit } from '../live';
import { Tip } from '../Tip';
import { useDisplayUi } from './displayStore';

const group = 'flex items-center rounded-lg border border-line bg-panel/90 p-0.5 backdrop-blur-sm';
const segment = (active: boolean) =>
  `flex h-6 w-7 items-center justify-center rounded-md ${active ? 'bg-raised text-accent shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim hover:text-text'}`;

const gizmoIcons = { translate: Move3d, rotate: Rotate3d, scale: Scale3d } as const;

/** The Display workspace's 3D view: the model in the reference scene of the chosen slot, with a gizmo. */
export function DisplayViewport() {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<DisplayView | null>(null);
  const [overlay, setOverlay] = useState<DisplayOverlay>({ crosshair: false, crop: null });
  const live = useLiveEdit();
  const liveRef = useRef(live);
  liveRef.current = live;
  const gizmo = useDisplayUi((s) => s.gizmo);
  const showGizmo = useDisplayUi((s) => s.showGizmo);
  const cameraReset = useDisplayUi((s) => s.cameraReset);
  const t = useT().display;

  useEffect(() => {
    const created = new DisplayView(host.current!, {
      onGizmo: (slot, transform) => liveRef.current.scrub('display.set_slot', { slot, ...transform }),
      onGizmoEnd: () => liveRef.current.end(),
      onOverlay: setOverlay,
    });
    view.current = created;
    const { gizmo: mode, showGizmo: visible } = useDisplayUi.getState();
    created.setGizmoMode(mode, visible);
    return () => {
      created.dispose();
      view.current = null;
    };
  }, []);

  useEffect(() => view.current?.setGizmoMode(gizmo, showGizmo), [gizmo, showGizmo]);
  useEffect(() => {
    if (cameraReset > 0) view.current?.resetCamera();
  }, [cameraReset]);

  const crop = overlay.crop;
  return (
    <div className="absolute inset-0 bg-ink">
      <div ref={host} className="absolute inset-0" data-testid="display-viewport" />
      {overlay.crosshair && (
        <svg aria-hidden className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" width="18" height="18" viewBox="0 0 18 18">
          <path d="M9 1v16M1 9h16" stroke="white" strokeWidth="2" opacity="0.85" style={{ mixBlendMode: 'difference' }} />
        </svg>
      )}
      {crop && (
        // Everything outside the slot's 16 x 16 px is dimmed: that is what the game crops to.
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-[1px] outline-1 outline-accent/70"
          style={{ left: crop.x, top: crop.y, width: crop.width, height: crop.height, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
        />
      )}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <div role="radiogroup" aria-label={t.gizmo} className={group}>
          {(['translate', 'rotate', 'scale'] as GizmoMode[]).map((mode) => {
            const Icon = gizmoIcons[mode];
            const active = showGizmo && gizmo === mode;
            return (
              <Tip key={mode} label={t.gizmoModes[mode]}>
                <button
                  role="radio"
                  aria-checked={active}
                  aria-label={t.gizmoModes[mode]}
                  className={segment(active)}
                  // A second click on the active mode hides the gizmo.
                  onClick={() => useDisplayUi.setState(active ? { showGizmo: false } : { gizmo: mode, showGizmo: true })}
                >
                  <Icon size={15} strokeWidth={1.75} />
                </button>
              </Tip>
            );
          })}
        </div>
        <div className={group}>
          <Tip label={t.resetCamera}>
            <button aria-label={t.resetCamera} className={segment(false)} onClick={() => useDisplayUi.setState((s) => ({ cameraReset: s.cameraReset + 1 }))}>
              <RefreshCcw size={14} strokeWidth={1.75} />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
