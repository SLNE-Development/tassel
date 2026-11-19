import { ArrowLeft, ArrowRight, Copy, Download, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { frameCount, frameHeight } from '../../core/minecraft/paintRegions';
import type { Texture } from '../../core/types';
import { useT } from '../../i18n';
import { textureBlob } from '../../viewport/textureImage';
import { Switch } from '../controls';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { editFrames, exportTexture, setAnimation } from './pixelActions';
import { shownFrame, usePixel, usePixelTexture } from './pixelStore';

const iconButton = 'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const sectionTitle = 'text-[calc(12px*var(--font-scale))] font-semibold text-dim';
const checker = {
  backgroundImage: 'repeating-conic-gradient(var(--line-strong) 0% 25%, var(--raised) 0% 50%)',
  backgroundSize: '8px 8px',
};

const FRAME_THUMB = 40;

/** One small image per frame of the texture, made when the texture's image changes. */
function useFrameThumbnails(texture: Texture | undefined): string[] {
  const [thumbs, setThumbs] = useState<{ texture: Texture; urls: string[] } | null>(null);
  useEffect(() => {
    if (!texture) return;
    let live = true;
    void (async () => {
      const count = frameCount(texture);
      const h = frameHeight(texture);
      const scale = FRAME_THUMB / Math.max(texture.width, h);
      const w = Math.max(1, Math.round(texture.width * scale));
      const th = Math.max(1, Math.round(h * scale));
      const bitmap = await createImageBitmap(textureBlob(texture));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = th;
      const context = canvas.getContext('2d')!;
      context.imageSmoothingEnabled = false;
      const urls: string[] = [];
      for (let i = 0; i < count; i++) {
        context.clearRect(0, 0, w, th);
        context.drawImage(bitmap, 0, i * h, texture.width, h, 0, 0, w, th);
        urls.push(canvas.toDataURL('image/png'));
      }
      bitmap.close();
      if (live) setThumbs({ texture, urls });
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [texture]);
  return thumbs && thumbs.texture === texture ? thumbs.urls : [];
}

/**
 * Plays the animation preview: while `playing` is set, the shown frame advances every frametime ticks
 * (1 tick = 50 ms). Mount it once while the pixel paint UI is on screen (AnimationPanel does).
 */
export function useAnimationPlayback(texture: Texture | undefined): void {
  const playing = usePixel((s) => s.playing);
  const count = texture ? frameCount(texture) : 1;
  const frametime = texture?.animation?.frametime ?? 1;
  useEffect(() => {
    if (!playing) return;
    if (count < 2) {
      usePixel.setState({ playing: false });
      return;
    }
    const timer = setInterval(() => usePixel.setState((s) => ({ frame: (shownFrame(texture, s.frame) + 1) % count })), Math.max(1, frametime) * 50);
    return () => clearInterval(timer);
    // The texture only matters through its frame count, so edits to its pixels do not restart the timer.
  }, [playing, count, frametime]);
}

function Tool({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button aria-label={label} disabled={disabled} className={iconButton} onClick={onClick}>
        {children}
      </button>
    </Tip>
  );
}

/** Frames of the painted texture, their timing, the preview and the export. */
export function AnimationPanel() {
  const t = useT().pixel.panel;
  const texture = usePixelTexture();
  const playing = usePixel((s) => s.playing);
  const frameState = usePixel((s) => s.frame);
  const thumbs = useFrameThumbnails(texture);
  useAnimationPlayback(texture);

  const count = texture ? frameCount(texture) : 1;
  const frame = shownFrame(texture, frameState);
  // The store may hold a frame that no longer exists (frames were deleted); bring it back in range.
  useEffect(() => {
    if (frameState !== frame) usePixel.setState({ frame });
  }, [frameState, frame]);

  if (!texture) return null;
  const animated = !!texture.animation;
  const canAnimate = texture.height % texture.width === 0;
  const animation = texture.animation;
  const last = count - 1;
  const frames = (action: 'add' | 'duplicate' | 'remove' | 'move', index: number, to?: number) => void editFrames(action, index, to);

  return (
    <section aria-label={t.animation} className="flex flex-col gap-2 border-t border-line pt-2.5">
      <div className="flex items-center gap-0.5">
        <h3 className={`${sectionTitle} flex-1`}>{t.animation}</h3>
        {animated && (
          <Tool label={playing ? t.pause : t.play} disabled={count < 2} onClick={() => usePixel.setState({ playing: !playing })}>
            {playing ? <Pause size={14} strokeWidth={1.75} /> : <Play size={14} strokeWidth={1.75} />}
          </Tool>
        )}
        <Tool label={t.exportTexture} onClick={() => void exportTexture(texture.id)}>
          <Download size={14} strokeWidth={1.75} />
        </Tool>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[calc(12.5px*var(--font-scale))] text-text">{t.animated}</span>
        <Switch
          label={t.animated}
          checked={animated}
          onChange={(on) => {
            if (!on) usePixel.setState({ playing: false });
            void setAnimation(texture, on ? { frametime: 1, interpolate: false } : null);
          }}
        />
      </div>
      {!canAnimate && !animated && <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{t.notAnimatable}</p>}
      {(animated || canAnimate) && (
        <>
          <div className="flex items-center gap-0.5">
            <span className="flex-1 text-[calc(12px*var(--font-scale))] text-dim">{t.frames}</span>
            <Tool label={t.addFrame} onClick={() => frames('add', count)} disabled={!canAnimate}>
              <Plus size={14} strokeWidth={1.75} />
            </Tool>
            <Tool label={t.duplicateFrame} onClick={() => frames('duplicate', frame)} disabled={!canAnimate}>
              <Copy size={14} strokeWidth={1.75} />
            </Tool>
            <Tool label={t.moveFrameLeft} onClick={() => frames('move', frame, frame - 1)} disabled={frame < 1}>
              <ArrowLeft size={14} strokeWidth={1.75} />
            </Tool>
            <Tool label={t.moveFrameRight} onClick={() => frames('move', frame, frame + 1)} disabled={frame >= last}>
              <ArrowRight size={14} strokeWidth={1.75} />
            </Tool>
            <Tool label={t.deleteFrame} onClick={() => frames('remove', frame)} disabled={count < 2}>
              <Trash2 size={14} strokeWidth={1.75} />
            </Tool>
          </div>
          <div role="listbox" aria-label={t.frames} className="flex gap-1 overflow-x-auto pb-1">
            {Array.from({ length: count }, (_, i) => (
              <Tip key={i} label={t.frameLabel(i + 1)}>
                <button
                  role="option"
                  aria-selected={i === frame}
                  aria-label={t.frameLabel(i + 1)}
                  className="relative size-10 shrink-0 overflow-hidden rounded-[5px] ring-1 ring-line-strong ring-inset hover:ring-faint aria-selected:ring-2 aria-selected:ring-accent"
                  style={checker}
                  onClick={() => usePixel.setState({ frame: i, playing: false })}
                >
                  {thumbs[i] && <img src={thumbs[i]} alt="" draggable={false} className="size-full object-contain" style={{ imageRendering: 'pixelated' }} />}
                  <span className="tnum absolute right-0.5 bottom-0 text-[calc(10px*var(--font-scale))] text-text [text-shadow:0_0_2px_var(--ink)]">{i + 1}</span>
                </button>
              </Tip>
            ))}
          </div>
        </>
      )}
      {animation && (
        <div className="flex items-center gap-2">
          <div className="w-32 shrink-0">
            <ScrubField
              wide
              label={t.frametime}
              ariaLabel={`${t.frametime} (${t.ticks})`}
              color="var(--dim)"
              value={animation.frametime}
              step={0.25}
              min={1}
              max={100_000}
              integer
              onCommit={(frametime) => void setAnimation(texture, { ...animation, frametime })}
            />
          </div>
          <span className="text-[calc(12px*var(--font-scale))] text-faint">{t.ticks}</span>
          <span className="ml-auto flex items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-text">
            {t.interpolate}
            <Switch label={t.interpolate} checked={animation.interpolate} onChange={(interpolate) => void setAnimation(texture, { ...animation, interpolate })} />
          </span>
        </div>
      )}
    </section>
  );
}
