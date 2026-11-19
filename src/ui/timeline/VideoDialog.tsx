import { Dialog } from '@base-ui/react/dialog';
import { Check, Download, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { execute, selectActiveDoc, useApp } from '../../app/store';
import { saveVideo } from '../../bridge/files';
import { DEFAULT_FPS, DEFAULT_FRAME_COUNT } from '../../core/animation';
import { DEFAULT_SECONDS_PER_FRAME, DEFAULT_VIDEO_SAMPLES, MAX_VIDEO_SIZE, MIN_VIDEO_SIZE, VIDEO_CANCELLED, type VideoFormat, type VideoQuality } from '../../core/video';
import { documentName, useT, type Dictionary } from '../../i18n';
import { cancelVideo, useVideoStatus } from '../../video';
import { PickMenu, Segmented } from '../controls';
import { ScrubField } from '../ScrubField';
import { notifyError, notifySuccess } from '../toast';
import { useVideoDialog } from './videoStore';

interface Result {
  video: { mimeType: 'video/mp4' | 'video/webm'; base64: string };
  frames: number;
  codecName: string;
  bytes: number;
  elapsedSeconds: number;
  warnings?: string[];
}

const sizes = [
  [640, 360],
  [1280, 720],
  [1920, 1080],
  [3840, 2160],
  [1080, 1080],
  [1080, 1920],
] as const;

const labelClass = 'truncate text-[calc(12.5px*var(--font-scale))] text-dim';
const quietButton =
  'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[calc(13px*var(--font-scale))] font-medium text-dim ring-1 ring-line-strong ring-inset hover:bg-raised hover:text-text disabled:text-faint/60 disabled:hover:bg-transparent';
const primaryButton = 'h-8 shrink-0 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className={labelClass}>{label}</span>
      <div className="flex min-h-7 min-w-0 items-center gap-1.5">{children}</div>
    </>
  );
}

function Num({ label, unit = '', value, min, max, step = 0.2, onCommit }: { label: string; unit?: string; value: number; min: number; max: number; step?: number; onCommit(value: number): void }) {
  return (
    <div className="w-full min-w-0">
      <ScrubField label={unit} ariaLabel={label} color="var(--faint)" value={value} step={step} min={min} max={max} integer onCommit={onCommit} />
    </div>
  );
}

/** "2 min 5 s" / "12 s" */
function duration(seconds: number, t: Dictionary['video']): string {
  const whole = Math.max(1, Math.round(seconds));
  return whole >= 60 ? t.minutes(Math.floor(whole / 60), whole % 60) : t.secondsOnly(whole);
}

function VideoBody() {
  const t = useT().video;
  const locale = useT().locale;
  const doc = useApp(selectActiveDoc);
  const animation = doc.state.animation;
  const fps = animation?.fps ?? DEFAULT_FPS;
  const last = (animation?.frameCount ?? DEFAULT_FRAME_COUNT) - 1;
  const progress = useVideoStatus((s) => s.progress);

  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(last);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const [quality, setQuality] = useState<VideoQuality>('viewport');
  const [samples, setSamples] = useState(DEFAULT_VIDEO_SAMPLES);
  const [perFrame, setPerFrame] = useState(DEFAULT_SECONDS_PER_FRAME);
  const [format, setFormat] = useState<VideoFormat>('mp4');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Only the latest export of this dialog may report back. */
  const run = useRef(0);

  // The range follows the animation when its length changes underneath the dialog.
  const first = Math.min(from, last);
  const end = Math.min(Math.max(to, first), last);
  const frames = end - first + 1;

  useEffect(
    () => () => {
      run.current++;
      cancelVideo();
    },
    [],
  );

  const save = async (out: Result) => {
    if (await saveVideo(out.video, documentName(doc))) notifySuccess(t.saved);
  };

  const start = async () => {
    const token = ++run.current;
    setRunning(true);
    setResult(null);
    setNote(null);
    try {
      const out = (await execute(
        'render.video',
        { fromFrame: first, toFrame: end, width: size.width, height: size.height, quality, format, ...(quality === 'render' ? { samples, maxSecondsPerFrame: perFrame } : {}) },
        { documentId: doc.id },
      )) as Result;
      if (run.current !== token) return;
      setResult(out);
      setRunning(false);
      await save(out);
    } catch (error) {
      if (run.current !== token) return;
      if (error instanceof Error && error.message === VIDEO_CANCELLED) setNote(t.cancelled);
      else notifyError(error);
    } finally {
      if (run.current === token) setRunning(false);
    }
  };

  const sizeKey = `${size.width}x${size.height}`;
  const percent = progress ? Math.round((progress.frame / progress.frames) * 100) : 0;
  const number = (value: number, digits: number) => value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  return (
    <>
      <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-5 py-4">
        <Row label={t.from}>
          <Num label={t.from} value={first} min={0} max={last} onCommit={setFrom} />
          <span className={`${labelClass} shrink-0`}>{t.to}</span>
          <Num label={t.to} value={end} min={0} max={last} onCommit={setTo} />
        </Row>
        <Row label={t.size}>
          <PickMenu
            label={t.size}
            value={sizes.some(([w, h]) => `${w}x${h}` === sizeKey) ? sizeKey : null}
            placeholder={t.customSize}
            options={sizes.map(([w, h]) => ({ value: `${w}x${h}`, title: `${w} × ${h}` }))}
            onChange={(key) => {
              const [width, height] = key.split('x').map(Number);
              setSize({ width, height });
            }}
          />
        </Row>
        <Row label={`${t.width} × ${t.height}`}>
          <Num label={t.width} value={size.width} step={2} min={MIN_VIDEO_SIZE} max={MAX_VIDEO_SIZE} onCommit={(width) => setSize({ ...size, width: Math.round(width / 2) * 2 })} />
          <Num label={t.height} value={size.height} step={2} min={MIN_VIDEO_SIZE} max={MAX_VIDEO_SIZE} onCommit={(height) => setSize({ ...size, height: Math.round(height / 2) * 2 })} />
        </Row>
        <Row label={t.quality}>
          <div className="min-w-0 flex-1">
            <Segmented<VideoQuality> label={t.quality} value={quality} options={(['viewport', 'render'] as const).map((value) => ({ value, title: t.qualities[value] }))} onChange={setQuality} />
          </div>
        </Row>
        {quality === 'render' && (
          <>
            <Row label={t.samples}>
              <Num label={t.samples} value={samples} min={1} max={4096} onCommit={setSamples} />
            </Row>
            <Row label={t.perFrame}>
              <Num label={t.perFrame} unit={t.seconds} value={perFrame} min={1} max={600} onCommit={setPerFrame} />
            </Row>
          </>
        )}
        <Row label={t.format}>
          <div className="min-w-0 flex-1">
            <Segmented<VideoFormat>
              label={t.format}
              value={format}
              options={[
                { value: 'mp4', title: 'MP4' },
                { value: 'webm', title: 'WebM' },
              ]}
              onChange={setFormat}
            />
          </div>
        </Row>
        <Row label={t.camera}>
          <span className="truncate text-[calc(12.5px*var(--font-scale))] text-text">{(animation?.camera.length ?? 0) > 0 ? t.cameraAnimated : t.cameraCurrent}</span>
        </Row>
        <p className="col-span-2 mt-1 text-[calc(12.5px*var(--font-scale))] leading-snug text-faint">
          {t.summary(frames, number(frames / fps, 1), number(fps, Number.isInteger(fps) ? 0 : 2))}
          {'. '}
          {quality === 'render' ? `${t.renderHint} ${t.estimate(duration(frames * perFrame, t))}.` : t.viewportHint}
        </p>
      </div>
      <footer className="flex min-h-14 shrink-0 items-center gap-3 border-t border-line px-5 py-3" aria-live="polite">
        <div className="min-w-0 flex-1">
          {running && progress ? (
            <div className="flex flex-col gap-1.5">
              <div role="progressbar" aria-label={t.exporting} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1 overflow-hidden rounded-full bg-ink ring-1 ring-line ring-inset">
                <div className="h-full rounded-full bg-accent transition-[width] duration-150 ease-linear" style={{ width: `${percent}%` }} />
              </div>
              <span className="tnum truncate text-[calc(12.5px*var(--font-scale))] text-text">
                {progress.phase === 'finishing'
                  ? t.finishing
                  : `${t.progress(progress.frame, progress.frames)}${progress.remaining !== null && progress.frame < progress.frames ? `, ${t.remaining(duration(progress.remaining, t))}` : ''}`}
              </span>
            </div>
          ) : result ? (
            <div className="flex items-start gap-2">
              <Check size={15} strokeWidth={2.25} className="mt-0.5 shrink-0 text-ok" />
              <p className="min-w-0 text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">
                {t.done(result.frames, result.codecName, number(result.bytes / (1024 * 1024), 1), number(result.elapsedSeconds, 1))}
                {result.warnings?.map((warning) => (
                  <span key={warning} className="mt-0.5 block text-faint">
                    {warning}
                  </span>
                ))}
              </p>
            </div>
          ) : (
            note && <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{note}</p>
          )}
        </div>
        {result && !running && (
          <button className={quietButton} onClick={() => void save(result).catch(notifyError)}>
            <Download size={14} strokeWidth={1.75} />
            {t.save}
          </button>
        )}
        {running ? (
          <button className={quietButton} onClick={cancelVideo}>
            {t.cancel}
          </button>
        ) : (
          <button className={primaryButton} onClick={() => void start()}>
            {t.export}
          </button>
        )}
      </footer>
    </>
  );
}

/** "Video exportieren…": the animation of the active document as an MP4 or WebM file. */
export function VideoDialog() {
  const t = useT();
  const open = useVideoDialog((s) => s.open);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && useVideoDialog.setState({ open: false })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(27rem,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl border border-line-strong bg-overlay shadow-pop outline-none">
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.video.title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          {open && <VideoBody />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
