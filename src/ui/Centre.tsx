import { memo } from 'react';
import { selectDocState, useApp } from '../app/store';
import { useT } from '../i18n';
import { Viewport } from '../viewport/Viewport';
import { shortcutLabel } from './actions';
import { LastOpPanel } from './LastOpPanel';
import { ModeSwitch } from './ModeSwitch';
import { PaintHint, PaintOptions } from './paint/PaintOptions';
import { PreviewOptions } from './preview/PreviewOptions';
import { CameraViewBadge, TimelineDock } from './timeline/Timeline';
import { SplitDivider } from './uv/SplitDivider';
import { UvEditor } from './uv/UvEditor';
import { UvOverlays } from './uv/UvMenu';
import { useUvUi } from './uv/uvStore';

// Never re-rendered by UI state: it takes no props and its parent passes none.
const ViewportHost = memo(function ViewportHost() {
  return (
    <div className="absolute inset-0">
      <Viewport />
    </div>
  );
});

const Key = ({ children }: { children: string }) => (
  <kbd className="rounded-[5px] border border-line-strong bg-panel px-1.5 py-0.5 font-sans text-[calc(12px*var(--font-scale))] text-text">{children}</kbd>
);

function EmptyHint() {
  const empty = useApp((s) => selectDocState(s).order.length === 0);
  const t = useT();
  if (!empty) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[14%] flex justify-center px-4">
      <p className="rounded-full border border-line bg-panel/85 px-4 py-2 text-[calc(13px*var(--font-scale))] text-dim backdrop-blur-sm">
        {t.viewport.emptyScene.before}
        <Key>{shortcutLabel('add.menu')!}</Key>
        {t.viewport.emptyScene.between}
        <Key>{shortcutLabel('palette.open')!}</Key>
        {t.viewport.emptyScene.after}
      </p>
    </div>
  );
}

export function Centre() {
  const workspace = useApp((s) => s.workspace);
  const split = useUvUi((s) => s.split);
  const uv = workspace === 'uv';
  return (
    <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-ink">
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
      {uv && (
        <div className="absolute inset-y-0 left-0" style={{ width: `${split * 100}%` }}>
          <UvEditor />
        </div>
      )}
      {/* The 3D view: everything in modelling, the right part next to the UV editor. Its overlays stay inside it. */}
      <div className="absolute inset-y-0 right-0 overflow-hidden" style={{ left: uv ? `${split * 100}%` : 0 }}>
        {/* The viewport stays mounted in every workspace so its camera and the screenshot service survive. */}
        <ViewportHost />
        <CameraViewBadge />
        {workspace === 'modeling' && <EmptyHint />}
        {workspace === 'paint' ? (
          // The 3D view is the canvas; the brush options float over it.
          <>
            <PaintOptions />
            <PaintHint />
          </>
        ) : (
          <>
            <ModeSwitch />
            <PreviewOptions />
            <LastOpPanel />
          </>
        )}
      </div>
      {uv && <SplitDivider />}
      <UvOverlays />
      </div>
      {/* The timeline docks under the views and takes its height from them. */}
      <TimelineDock />
    </main>
  );
}
