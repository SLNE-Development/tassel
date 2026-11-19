import { Dialog } from '@base-ui/react/dialog';
import { Check, ClipboardCopy, Download, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { execute, selectActiveDoc, useApp } from '../../app/store';
import { saveImage } from '../../bridge/files';
import { environmentPresets, presetSun, renderSettingsOf, type RenderSettings, type RenderSettingsPatch } from '../../core/render';
import { viewPresets } from '../../core/types';
import { documentName, useT } from '../../i18n';
import { RENDER_CANCELLED, RENDER_SUPERSEDED, cancelRender, releaseRenderer, retainRenderer, stopRender, useRenderStatus } from '../../render';
import { PickMenu, Segmented, Switch } from '../controls';
import { ColorField, UnitSlider, useLive } from '../materialControls';
import { ScrubField } from '../ScrubField';
import { notifyError, notifySuccess } from '../toast';
import { useRenderDialog } from './renderStore';

interface Result {
  image: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string };
  samples: number;
  targetSamples: number;
  seconds: number;
  converged: boolean;
}

const sizes = [
  [1280, 720],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
  [1600, 1200],
  [1080, 1080],
  [1080, 1350],
] as const;
const sampleCounts = [32, 128, 512, 2048] as const;

const labelClass = 'text-[calc(12.5px*var(--font-scale))] text-dim';
const quietButton =
  'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[calc(13px*var(--font-scale))] font-medium text-dim ring-1 ring-line-strong ring-inset hover:bg-raised hover:text-text disabled:text-faint/60 disabled:hover:bg-transparent';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="border-b border-line px-4 pt-3 pb-3.5 last:border-b-0">
      <h3 className="mb-2 text-[calc(12px*var(--font-scale))] font-semibold text-text">{title}</h3>
      <div className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={`${labelClass} truncate`}>{label}</span>
      <div className="flex min-h-7 min-w-0 items-center justify-end gap-1.5">{children}</div>
    </>
  );
}

function Num({ label, unit = '', value, step, min, max, integer, onCommit }: { label: string; unit?: string; value: number; step: number; min?: number; max?: number; integer?: boolean; onCommit(value: number): void }) {
  return (
    <div className="w-full min-w-0">
      <ScrubField label={unit} ariaLabel={label} color="var(--faint)" value={value} step={step} min={min} max={max} integer={integer} onCommit={onCommit} />
    </div>
  );
}

/** The right-hand column: every setting of the document, changed through render.set_settings. */
function Settings({ settings }: { settings: RenderSettings }) {
  const t = useT().render;
  const views = useT().views;
  const live = useLive();
  const set = (patch: RenderSettingsPatch) => void execute('render.set_settings', patch).catch(notifyError);
  const scrub = (patch: RenderSettingsPatch) => live.scrub('render.set_settings', patch as Record<string, unknown>);
  const { environment, sun, background, ground, camera, depthOfField, output } = settings;
  const sizeKey = `${output.width}x${output.height}`;
  const view = typeof camera.view === 'string' ? camera.view : 'custom';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Section title={t.sections.light}>
        <Row label={t.environment}>
          <PickMenu
            label={t.environment}
            value={environment.preset}
            placeholder=""
            options={environmentPresets.map((preset) => ({ value: preset, title: t.presets[preset] }))}
            // Each surrounding comes with the sun that suits it.
            onChange={(preset) => set({ environment: { preset }, sun: presetSun[preset] })}
          />
        </Row>
        <Row label={t.intensity}>
          <Num label={t.intensity} value={environment.intensity} step={0.01} min={0} max={20} onCommit={(intensity) => set({ environment: { intensity } })} />
        </Row>
        <Row label={t.rotation}>
          <Num label={t.rotation} unit="°" value={environment.rotation} step={1} min={-360} max={360} onCommit={(rotation) => set({ environment: { rotation } })} />
        </Row>
        <Row label={t.sun}>
          <Switch checked={sun.enabled} label={t.sun} onChange={(enabled) => set({ sun: { enabled } })} />
        </Row>
        {sun.enabled && (
          <>
            <Row label={t.azimuth}>
              <Num label={t.azimuth} unit="°" value={sun.azimuth} step={1} min={-360} max={360} onCommit={(azimuth) => set({ sun: { azimuth } })} />
            </Row>
            <Row label={t.elevation}>
              <Num label={t.elevation} unit="°" value={sun.elevation} step={0.5} min={0} max={90} onCommit={(elevation) => set({ sun: { elevation } })} />
            </Row>
            <Row label={t.sunIntensity}>
              <Num label={t.sunIntensity} value={sun.intensity} step={0.02} min={0} max={50} onCommit={(intensity) => set({ sun: { intensity } })} />
            </Row>
            <Row label={t.softness}>
              <Num label={t.softness} unit="°" value={sun.softness} step={0.05} min={0.5} max={30} onCommit={(softness) => set({ sun: { softness } })} />
            </Row>
          </>
        )}
      </Section>

      <Section title={t.sections.backdrop}>
        <Row label={t.background}>
          <PickMenu
            label={t.background}
            value={background.type}
            placeholder=""
            options={(['gradient', 'color', 'environment', 'transparent'] as const).map((type) => ({ value: type, title: t.backgrounds[type] }))}
            // JPEG has no alpha channel: a transparent picture is written as PNG.
            onChange={(type) => set({ background: { type }, ...(type === 'transparent' && output.format === 'jpeg' ? { output: { format: 'png' } } : {}) })}
          />
        </Row>
        {background.type === 'gradient' && (
          <Row label={t.topColor}>
            <ColorField label={t.topColor} value={background.topColor} onCommit={(topColor) => set({ background: { topColor } })} onScrub={(topColor) => scrub({ background: { topColor } })} onScrubEnd={live.end} />
          </Row>
        )}
        {(background.type === 'gradient' || background.type === 'color') && (
          <Row label={background.type === 'gradient' ? t.bottomColor : t.color}>
            <ColorField label={t.color} value={background.color} onCommit={(color) => set({ background: { color } })} onScrub={(color) => scrub({ background: { color } })} onScrubEnd={live.end} />
          </Row>
        )}
        <Row label={t.ground}>
          <Switch checked={ground.type === 'plane'} label={t.ground} onChange={(on) => set({ ground: { type: on ? 'plane' : 'none' } })} />
        </Row>
        {ground.type === 'plane' && (
          <>
            <Row label={t.groundColor}>
              <ColorField label={t.groundColor} value={ground.color} onCommit={(color) => set({ ground: { color } })} onScrub={(color) => scrub({ ground: { color } })} onScrubEnd={live.end} />
            </Row>
            <div className="col-span-2">
              <UnitSlider label={t.reflectivity} value={ground.reflectivity} onScrub={(reflectivity) => scrub({ ground: { reflectivity } })} onScrubEnd={live.end} />
            </div>
          </>
        )}
      </Section>

      <Section title={t.sections.camera}>
        <Row label={t.view}>
          <PickMenu
            label={t.view}
            value={view === 'custom' ? null : view}
            placeholder={t.customCamera}
            options={[{ value: 'current', title: t.currentView }, ...viewPresets.map((preset) => ({ value: preset, title: views[preset] }))]}
            onChange={(next) => set({ camera: { view: next as RenderSettings['camera']['view'] } })}
          />
        </Row>
        {(view === 'current' || view === 'custom') && (
          <Row label={t.fit}>
            <Switch checked={camera.fit} label={t.fit} onChange={(fit) => set({ camera: { fit } })} />
          </Row>
        )}
        <Row label={t.depthOfField}>
          <Switch checked={depthOfField.enabled} label={t.depthOfField} onChange={(enabled) => set({ depthOfField: { enabled } })} />
        </Row>
        {depthOfField.enabled && (
          <Row label={t.fStop}>
            <Num label={t.fStop} unit="f/" value={depthOfField.fStop} step={0.02} min={0.1} max={64} onCommit={(fStop) => set({ depthOfField: { fStop } })} />
          </Row>
        )}
      </Section>

      <Section title={t.sections.output}>
        <Row label={t.size}>
          <PickMenu
            label={t.size}
            value={sizes.some(([w, h]) => `${w}x${h}` === sizeKey) ? sizeKey : null}
            placeholder={t.customSize}
            options={sizes.map(([w, h]) => ({ value: `${w}x${h}`, title: `${w} × ${h}` }))}
            onChange={(key) => {
              const [width, height] = key.split('x').map(Number);
              set({ output: { width, height } });
            }}
          />
        </Row>
        <Row label={`${t.width} × ${t.height}`}>
          <Num label={t.width} value={output.width} step={4} min={16} max={4096} integer onCommit={(width) => set({ output: { width } })} />
          <Num label={t.height} value={output.height} step={4} min={16} max={4096} integer onCommit={(height) => set({ output: { height } })} />
        </Row>
        <div className="col-span-2 mt-0.5 grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-3">
          <span className={labelClass}>{t.samples}</span>
          <Segmented label={t.samples} value={output.samples} options={sampleCounts.map((value) => ({ value, title: String(value) }))} onChange={(samples) => set({ output: { samples } })} />
        </div>
        <Row label={t.maxSeconds}>
          <Num label={t.maxSeconds} unit={t.seconds} value={output.maxSeconds} step={1} min={1} max={600} integer onCommit={(maxSeconds) => set({ output: { maxSeconds } })} />
        </Row>
        <div className="col-span-2 grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-3">
          <span className={labelClass}>{t.toneMapping}</span>
          <Segmented
            label={t.toneMapping}
            value={output.toneMapping}
            options={(['aces', 'agx', 'neutral'] as const).map((value) => ({ value, title: t.toneMappings[value] }))}
            onChange={(toneMapping) => set({ output: { toneMapping } })}
          />
        </div>
        <Row label={t.exposure}>
          <Num label={t.exposure} unit="EV" value={output.exposure} step={0.02} min={-10} max={10} onCommit={(exposure) => set({ output: { exposure } })} />
        </Row>
        <div className="col-span-2">
          <UnitSlider label={t.denoise} value={output.denoise} onScrub={(denoise) => scrub({ output: { denoise } })} onScrubEnd={live.end} />
        </div>
        <div className="col-span-2 grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] items-center gap-x-3">
          <span className={labelClass}>{t.format}</span>
          <Segmented
            label={t.format}
            value={output.format}
            options={[
              { value: 'png', title: 'PNG' },
              { value: 'jpeg', title: 'JPEG' },
              { value: 'webp', title: 'WebP' },
            ]}
            onChange={(format) => set({ output: { format }, ...(format === 'jpeg' && background.type === 'transparent' ? { background: { type: 'color' } } : {}) })}
          />
        </div>
      </Section>
    </div>
  );
}

/** Where the picture appears: the renderer's own canvas, live while it works. */
function Stage({ ratio, showCanvas }: { ratio: number; showCanvas: boolean }) {
  const t = useT().render;
  const canvas = useRenderStatus((s) => s.canvas);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = host.current;
    if (!element || !canvas || !showCanvas) return;
    canvas.className = 'block size-full';
    element.appendChild(canvas);
    return () => {
      if (canvas.parentElement === element) element.removeChild(canvas);
    };
  }, [canvas, showCanvas]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-ink p-4 [container-type:size]">
      {showCanvas ? (
        // The frame has the picture's proportions and is as large as the space allows.
        <div
          ref={host}
          role="img"
          aria-label={t.image}
          className="overflow-hidden rounded-[3px] shadow-pop ring-1 ring-line-strong"
          // A chequered ground shows where the picture is transparent.
          style={{ aspectRatio: String(ratio), width: `min(100cqw, calc(100cqh * ${ratio}))`, backgroundImage: 'repeating-conic-gradient(var(--line-strong) 0% 25%, transparent 0% 50%)', backgroundSize: '16px 16px' }}
        />
      ) : (
        <p className="max-w-[22rem] text-center text-[calc(13px*var(--font-scale))] leading-relaxed text-faint">{t.empty}</p>
      )}
    </div>
  );
}

function RenderBody() {
  const t = useT().render;
  const doc = useApp(selectActiveDoc);
  const settings = renderSettingsOf(doc.state);
  const progress = useRenderStatus((s) => s.progress);
  const interactive = useRenderStatus((s) => s.interactive);
  const picture = useRenderStatus((s) => s.picture);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Every start gets a number; only the latest one may report back. */
  const run = useRef(0);
  /** After the first render of this dialog, changes are rendered without asking. */
  const armed = useRef(false);

  useEffect(() => {
    retainRenderer();
    return () => {
      run.current++;
      cancelRender('interactive');
      releaseRenderer();
    };
  }, []);

  const start = async () => {
    const token = ++run.current;
    armed.current = true;
    setRunning(true);
    setNote(null);
    setResult(null);
    try {
      const targetSamples = renderSettingsOf(selectActiveDoc(useApp.getState()).state).output.samples;
      const out = (await execute('render.image', { interactive: true }, { documentId: doc.id })) as Omit<Result, 'targetSamples'>;
      if (run.current === token) setResult({ ...out, targetSamples });
    } catch (error) {
      if (run.current !== token) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message === RENDER_SUPERSEDED) setNote(t.superseded);
      else if (message !== RENDER_CANCELLED) notifyError(error);
    } finally {
      if (run.current === token) setRunning(false);
    }
  };

  // What the picture depends on; the file format and quality only matter when it is saved.
  const key = useMemo(() => JSON.stringify({ ...settings, output: { ...settings.output, format: 0, quality: 0 } }), [settings]);
  const objects = doc.state.objects;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!armed.current) return;
    // A moment of quiet, so that scrubbing a value does not start a render per step.
    const timer = setTimeout(() => void start(), 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, objects]);

  const mine = running && interactive;
  const waiting = running && !interactive && progress !== null;
  const percent = mine && progress?.phase !== 'preparing' ? Math.round(Math.min(1, progress ? progress.samples / progress.targetSamples : 0) * 100) : 0;

  const save = async () => {
    if (!result) return;
    try {
      // The picture is encoded in the format chosen when it was rendered; a format changed since needs the canvas.
      const wanted = `image/${settings.output.format}` as Result['image']['mimeType'];
      let image = result.image;
      const canvas = useRenderStatus.getState().canvas;
      if (image.mimeType !== wanted && canvas) {
        const url = canvas.toDataURL(wanted, settings.output.quality);
        if (url.startsWith(`data:${wanted}`)) image = { mimeType: wanted, base64: url.slice(url.indexOf(',') + 1) };
      }
      if (await saveImage(image, documentName(doc))) notifySuccess(t.saved);
    } catch (error) {
      notifyError(error);
    }
  };

  const copy = async () => {
    const canvas = useRenderStatus.getState().canvas;
    if (!result || !canvas) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('The image could not be copied');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      notifySuccess(t.copied);
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Stage ratio={settings.output.width / settings.output.height} showCanvas={picture !== null && (running || result !== null)} />
        <footer className="flex min-h-12 shrink-0 items-center gap-3 border-t border-line px-4 py-2" aria-live="polite">
          <div className="min-w-0 flex-1">
            {mine && progress ? (
              <div className="flex items-center gap-3">
                <div role="progressbar" aria-label={t.rendering} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-ink ring-1 ring-line ring-inset">
                  <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-linear" style={{ width: `${percent}%` }} />
                </div>
                <span className="tnum shrink-0 text-right text-[calc(12.5px*var(--font-scale))] text-text">
                  {progress.phase === 'preparing' ? (progress.seconds > 4 ? t.compiling : t.preparing) : progress.phase === 'encoding' ? t.encoding : t.progress(progress.samples, progress.targetSamples, Math.round(progress.seconds))}
                </span>
              </div>
            ) : waiting ? (
              <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.busy}</p>
            ) : result ? (
              <div className="flex items-start gap-2">
                {result.converged ? <Check size={15} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ok" /> : <TriangleAlert size={15} className="mt-0.5 shrink-0 text-accent" />}
                <p className="min-w-0 text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">
                  {result.converged ? t.done(result.samples, Math.round(result.seconds * 10) / 10) : t.doneEarly(result.samples, result.targetSamples, Math.round(result.seconds * 10) / 10)}
                </p>
              </div>
            ) : (
              note && <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{note}</p>
            )}
          </div>
          <button className={quietButton} disabled={!result || running} onClick={() => void copy()} aria-label={t.copy} title={t.copy}>
            <ClipboardCopy size={14} strokeWidth={1.75} />
          </button>
          <button className={quietButton} disabled={!result || running} onClick={() => void save()}>
            <Download size={14} strokeWidth={1.75} />
            {t.save}
          </button>
        </footer>
      </div>
      <aside className="flex w-[19.5rem] shrink-0 flex-col border-l border-line bg-panel">
        <Settings settings={settings} />
        <div className="flex shrink-0 gap-2 border-t border-line p-3">
          {running ? (
            <button className={`${quietButton} flex-1 justify-center`} onClick={() => (mine ? stopRender('interactive') : (run.current++, cancelRender('interactive'), setRunning(false)))}>
              {t.stop}
            </button>
          ) : (
            <button
              className="h-8 flex-1 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110 disabled:bg-raised disabled:text-faint disabled:hover:brightness-100"
              onClick={() => void start()}
            >
              {result ? t.renderAgain : t.render}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}

/** "Rendern…": a path-traced picture of the active document, with its settings. */
export function RenderDialog() {
  const t = useT();
  const open = useRenderDialog((s) => s.open);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && useRenderDialog.setState({ open: false })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-[min(46rem,calc(100%-2rem))] w-[min(78rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none">
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.render.title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          {open && <RenderBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
