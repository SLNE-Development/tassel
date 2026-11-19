import { Popover } from '@base-ui/react/popover';
import { FlipHorizontal2, Grid3x3, LayoutGrid, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { mirrorAxes } from '../../core/minecraft/paintRegions';
import { brushShapes, pixelBlendModes, selectModes } from '../../core/pixelOps';
import { useT } from '../../i18n';
import { PickMenu, Segmented, Switch } from '../controls';
import { UnitSlider } from '../materialControls';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { MAX_PIXEL_BRUSH, pixelFillModes, selectKinds, setPixelSize, shapeKinds, usePixel, type PixelTool, type PixelUiState } from './pixelStore';
import { selectAll, selectNone } from './pixelTools';

// The options live in the pixel store, not in the document: a change is there at once.
const done = Promise.resolve();
const set = (change: Partial<PixelUiState>) => {
  usePixel.setState(change);
  return done;
};
const noop = () => {};

const Divider = () => <div aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-line-strong" />;

const buttonBase = 'flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2 text-[calc(12.5px*var(--font-scale))] ring-1 ring-inset';

/** A button that stays pressed: an option that is on or off. */
function Toggle({ label, pressed, onChange, icon: Icon, tip }: { label: string; pressed: boolean; onChange(pressed: boolean): void; icon?: LucideIcon; tip?: string }) {
  return (
    <Tip label={tip ?? label}>
      <button
        aria-pressed={pressed}
        aria-label={label}
        className={`${buttonBase} ${pressed ? 'bg-raised text-accent ring-accent' : 'text-dim ring-line hover:text-text hover:ring-line-strong'}`}
        onClick={() => onChange(!pressed)}
      >
        {Icon && <Icon size={14} strokeWidth={1.75} />}
        {!Icon || !tip ? <span className="truncate">{label}</span> : null}
      </button>
    </Tip>
  );
}

function ActionButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button className={`${buttonBase} text-text ring-line-strong hover:bg-raised hover:ring-faint`} onClick={onClick}>
      <span className="truncate">{label}</span>
    </button>
  );
}

const Field = ({ width, children }: { width: string; children: ReactNode }) => <div className={`${width} shrink-0`}>{children}</div>;

function Size() {
  const size = usePixel((s) => s.size);
  const t = useT().pixel.panel;
  return (
    <Tip label={t.size} shortcut="[ ]">
      <div className="w-25 shrink-0">
        <ScrubField wide label={t.size} ariaLabel={t.size} color="var(--dim)" value={size} step={0.5} min={1} max={MAX_PIXEL_BRUSH} integer onCommit={setPixelSize} onScrub={setPixelSize} />
      </div>
    </Tip>
  );
}

function Opacity() {
  const opacity = usePixel((s) => s.opacity);
  const t = useT().pixel.panel;
  return (
    <Field width="w-30">
      <UnitSlider label={t.opacity} value={opacity} onScrub={(next) => set({ opacity: next })} onScrubEnd={noop} />
    </Field>
  );
}

function Blending() {
  const blend = usePixel((s) => s.blend);
  const t = useT().pixel.panel;
  return (
    <Field width="w-36">
      <PickMenu label={t.blend} value={blend} placeholder="" options={pixelBlendModes.map((value) => ({ value, title: t.blends[value] }))} onChange={(next) => void set({ blend: next })} />
    </Field>
  );
}

function Tolerance() {
  const tolerance = usePixel((s) => s.tolerance);
  const t = useT().pixel.panel;
  return (
    <Field width="w-32">
      <UnitSlider label={t.tolerance} value={tolerance} onScrub={(next) => set({ tolerance: next })} onScrubEnd={noop} />
    </Field>
  );
}

function LabelledSegmented<T extends string>({ label, value, options, onChange, width }: { label: string; value: T; options: readonly { value: T; title: string }[]; onChange(value: T): void; width: string }) {
  return (
    <Field width={width}>
      <Segmented label={label} value={value} options={options} onChange={onChange} />
    </Field>
  );
}

function Mirror() {
  const mirror = usePixel((s) => s.mirror);
  const t = useT().pixel.panel;
  const change = (next: Partial<PixelUiState['mirror']>) => usePixel.setState({ mirror: { ...mirror, ...next } });
  const row = 'flex items-center justify-between gap-4 text-[calc(12.5px*var(--font-scale))] text-text';
  return (
    <Popover.Root>
      <Tip label={t.mirror}>
        <Popover.Trigger
          aria-label={t.mirror}
          className={`${buttonBase} ${mirror.enabled ? 'bg-raised text-accent ring-accent' : 'text-dim ring-line hover:text-text hover:ring-line-strong'} data-[popup-open]:ring-accent`}
        >
          <FlipHorizontal2 size={14} strokeWidth={1.75} />
        </Popover.Trigger>
      </Tip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup aria-label={t.mirror} className="anim-pop flex w-60 flex-col gap-2.5 rounded-lg border border-line-strong bg-overlay p-3 shadow-pop outline-none">
            <div className={row}>
              <span>{t.mirrorOn}</span>
              <Switch label={t.mirrorOn} checked={mirror.enabled} onChange={(enabled) => change({ enabled })} />
            </div>
            <div className={`flex flex-col gap-2.5 ${mirror.enabled ? '' : 'pointer-events-none opacity-40'}`}>
              {mirrorAxes.map((axis) => {
                const on = mirror.axes.includes(axis);
                const label = t.mirrorAxis(axis.toUpperCase());
                return (
                  <div key={axis} className={row}>
                    <span>{label}</span>
                    <Switch label={label} checked={on} onChange={(next) => change({ axes: next ? [...mirror.axes, axis] : mirror.axes.filter((a) => a !== axis) })} />
                  </div>
                );
              })}
              <div className="flex flex-col gap-1">
                <span className="text-[calc(12px*var(--font-scale))] text-dim">{t.mirrorMode}</span>
                <Segmented
                  label={t.mirrorMode}
                  value={mirror.mode}
                  options={(['global', 'local'] as const).map((value) => ({ value, title: t.mirrorModes[value] }))}
                  onChange={(mode) => change({ mode })}
                />
              </div>
              <div className={row}>
                <span>{t.mirrorImage}</span>
                <Switch label={t.mirrorImage} checked={mirror.image} onChange={(image) => change({ image })} />
              </div>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** What each tool offers, in the order it is shown. */
function ToolOptions({ tool }: { tool: PixelTool }) {
  const s = usePixel();
  const t = useT().pixel.panel;
  switch (tool) {
    case 'brush':
    case 'eraser':
      return (
        <>
          <Toggle label={t.pixelPerfect} pressed={s.pixelPerfect} onChange={(pixelPerfect) => usePixel.setState({ pixelPerfect })} />
          <Size />
          <LabelledSegmented width="w-28" label={t.brushShape} value={s.shape} options={brushShapes.map((value) => ({ value, title: t.brushShapes[value] }))} onChange={(shape) => usePixel.setState({ shape })} />
          <Opacity />
          <Blending />
          <Toggle label={t.lockAlpha} pressed={s.lockAlpha} onChange={(lockAlpha) => usePixel.setState({ lockAlpha })} />
          {tool === 'brush' && <Toggle label={t.eraseMode} pressed={s.eraseMode} onChange={(eraseMode) => usePixel.setState({ eraseMode })} />}
          <Mirror />
        </>
      );
    case 'fill':
      return (
        <>
          <Field width="w-44">
            <PickMenu label={t.fillMode} value={s.fillMode} placeholder="" options={pixelFillModes.map((value) => ({ value, title: t.fillModes[value] }))} onChange={(fillMode) => usePixel.setState({ fillMode })} />
          </Field>
          <Tolerance />
          <Opacity />
          <Blending />
          <Mirror />
        </>
      );
    case 'shape':
      return (
        <>
          <LabelledSegmented width="w-44" label={t.shapeKind} value={s.shapeKind} options={shapeKinds.map((value) => ({ value, title: t.shapeKinds[value] }))} onChange={(shapeKind) => usePixel.setState({ shapeKind })} />
          <LabelledSegmented
            width="w-36"
            label={t.shapeFilled}
            value={s.shapeFilled ? 'filled' : 'hollow'}
            options={[
              { value: 'filled', title: t.shapeFilled },
              { value: 'hollow', title: t.shapeHollow },
            ]}
            onChange={(value) => usePixel.setState({ shapeFilled: value === 'filled' })}
          />
          {!s.shapeFilled && (
            <div className="w-32 shrink-0">
              <ScrubField wide label={t.lineWidth} ariaLabel={t.lineWidth} color="var(--dim)" value={s.lineWidth} step={0.5} min={1} max={64} integer onCommit={(lineWidth) => usePixel.setState({ lineWidth })} onScrub={(lineWidth) => usePixel.setState({ lineWidth })} />
            </div>
          )}
          <Opacity />
          <Blending />
          <Mirror />
        </>
      );
    case 'gradient':
      return (
        <>
          <Opacity />
          <Blending />
        </>
      );
    case 'select':
      return (
        <>
          <Field width="w-36">
            <PickMenu label={t.selectKind} value={s.selectKind} placeholder="" options={selectKinds.map((value) => ({ value, title: t.selectKinds[value] }))} onChange={(selectKind) => usePixel.setState({ selectKind })} />
          </Field>
          <Field width="w-36">
            <PickMenu label={t.selectMode} value={s.selectMode} placeholder="" options={selectModes.map((value) => ({ value, title: t.selectModes[value] }))} onChange={(selectMode) => usePixel.setState({ selectMode })} />
          </Field>
          {(s.selectKind === 'wand' || s.selectKind === 'color') && <Tolerance />}
          <ActionButton label={t.selectAll} onClick={selectAll} />
          <ActionButton label={t.deselect} onClick={selectNone} />
        </>
      );
    case 'copy':
      return (
        <>
          <Field width="w-40">
            <PickMenu
              label={t.copyMode}
              value={s.copyMode}
              placeholder=""
              options={(['copy', 'pattern', 'sample'] as const).map((value) => ({ value, title: t.copyModes[value] }))}
              onChange={(copyMode) => usePixel.setState({ copyMode })}
            />
          </Field>
          <Size />
          <LabelledSegmented width="w-28" label={t.brushShape} value={s.shape} options={brushShapes.map((value) => ({ value, title: t.brushShapes[value] }))} onChange={(shape) => usePixel.setState({ shape })} />
          <Opacity />
          <span className="shrink-0 px-1 text-[calc(12px*var(--font-scale))] text-faint">{t.copyHint}</span>
        </>
      );
    case 'move':
    case 'picker':
      return null;
  }
}

/** The options of the current pixel tool, floating over the top of the views; tiling and the grid are always there. */
export function PixelOptions() {
  const tool = usePixel((s) => s.tool);
  const tiled = usePixel((s) => s.tiled);
  const grid = usePixel((s) => s.grid);
  const t = useT().pixel.panel;
  return (
    <div className="@container pointer-events-none absolute inset-x-2 top-2 flex justify-center">
      <div
        role="toolbar"
        aria-label={t.options}
        className="pointer-events-auto flex max-w-full min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-overlay/95 p-1.5 shadow-pop backdrop-blur-sm"
      >
        <ToolOptions tool={tool} />
        {tool !== 'move' && tool !== 'picker' && <Divider />}
        <Toggle label={t.tiled} tip={t.tiled} icon={LayoutGrid} pressed={tiled} onChange={(next) => usePixel.setState({ tiled: next })} />
        <Toggle label={t.grid} tip={t.grid} icon={Grid3x3} pressed={grid} onChange={(next) => usePixel.setState({ grid: next })} />
      </div>
    </div>
  );
}
