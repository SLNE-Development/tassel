import { ArrowDownToLine, Eye, EyeOff, Layers2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, type ReactNode } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { blendModes, type PaintLayer, type Texture } from '../../core/types';
import { useT } from '../../i18n';
import { PickMenu } from '../controls';
import { LiveEdit } from '../live';
import { UnitSlider } from '../materialControls';
import { useThumbnail } from '../textureFiles';
import { Tip } from '../Tip';
import { AnimationPanel } from './AnimationPanel';
import { ColorPanel } from './ColorPanel';
import { ImageMenu } from './ImageMenu';
import { addPixelLayer, flattenPixelLayers, mergePixelLayerDown, removePixelLayer, selectPixelLayer, updatePixelLayer } from './pixelActions';
import { pixelLayer, usePixel, usePixelTexture } from './pixelStore';

const iconButton = 'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const sectionTitle = 'text-[calc(12px*var(--font-scale))] font-semibold text-dim';
/** Transparency shows as a quiet checker in both themes. */
const checker = {
  backgroundImage: 'repeating-conic-gradient(var(--line-strong) 0% 25%, var(--raised) 0% 50%)',
  backgroundSize: '8px 8px',
};

function Thumb({ url, size = 'size-7' }: { url: string | null; size?: string }) {
  return (
    <span aria-hidden className={`${size} shrink-0 overflow-hidden rounded-[5px] ring-1 ring-line-strong ring-inset`} style={checker}>
      {url && <img src={url} alt="" draggable={false} className="size-full object-contain" style={{ imageRendering: 'pixelated' }} />}
    </span>
  );
}

// ------------------------------------------------------------------ textures

function TextureRow({ texture, active }: { texture: Texture; active: boolean }) {
  const thumbnail = useThumbnail(texture);
  const t = useT();
  return (
    <li>
      <button
        aria-current={active}
        className={`flex h-9 w-full items-center gap-2 rounded-md pr-2 pl-1 text-left ${active ? 'bg-raised shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'hover:bg-raised/50'}`}
        onClick={() => usePixel.setState({ textureId: texture.id, frame: 0, playing: false, selection: null })}
      >
        <Thumb url={thumbnail} />
        <span className="min-w-0 flex-1 truncate text-[calc(12.5px*var(--font-scale))] text-text">{texture.name}</span>
        <span className="tnum shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{t.paint.pixels(texture.width, texture.height)}</span>
      </button>
    </li>
  );
}

function Textures({ current }: { current: Texture | undefined }) {
  const textures = useApp((s) => selectDocState(s).textures);
  const t = useT().pixel.panel;
  const list = Object.values(textures);
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
      <h3 className={sectionTitle}>{t.textures}</h3>
      {list.length === 0 ? (
        <div role="note" className="rounded-md bg-ink px-2.5 py-2.5 ring-1 ring-line ring-inset">
          <p className="text-[calc(13px*var(--font-scale))] font-medium text-text">{t.noTextures}</p>
          <p className="mt-0.5 text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">{t.noTexturesHint}</p>
        </div>
      ) : (
        <ul aria-label={t.textures} className="flex max-h-44 flex-col gap-px overflow-y-auto">
          {list.map((texture) => (
            <TextureRow key={texture.id} texture={texture} active={texture.id === current?.id} />
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ layers

/**
 * Live changes of a layer value through `paint.update_layer`, one undo step per drag. The command re-encodes
 * the texture, so the next drag waits for it instead of running into it.
 */
function useLayerLive(): { scrub(params: Record<string, unknown>): Promise<void>; end(): void } {
  const state = useRef<{ edit: LiveEdit | null; last: Promise<void>; previous: Promise<void> }>({ edit: null, last: Promise.resolve(), previous: Promise.resolve() });
  return {
    scrub(params) {
      const s = state.current;
      const edit = (s.edit ??= new LiveEdit());
      s.last = s.previous.then(() => edit.apply('paint.update_layer', params));
      return s.last;
    },
    end() {
      const s = state.current;
      s.previous = s.last;
      s.edit = null;
    },
  };
}

function LayerRow({ texture, layer, active }: { texture: Texture; layer: PaintLayer; active: boolean }) {
  // The layer's image as a texture of its own: the thumbnail cache follows the object, which changes with the layer.
  const asTexture = useMemo<Texture>(() => ({ ...texture, id: layer.id, data: layer.data, mimeType: 'image/png', layers: undefined, animation: undefined }), [layer.data, layer.id, texture.width, texture.height]);
  const thumbnail = useThumbnail(asTexture);
  const t = useT().paint;
  const toggle = layer.visible ? t.hideLayer(layer.name) : t.showLayer(layer.name);
  return (
    <li
      aria-current={active}
      className={`relative flex h-9 items-center gap-1.5 rounded-md pr-2 pl-0.5 ${active ? 'bg-raised shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'hover:bg-raised/50'}`}
      onClick={() => selectPixelLayer(texture.id, layer.id)}
    >
      {active && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent" />}
      <Tip label={toggle} side="left">
        <button
          aria-label={toggle}
          aria-pressed={layer.visible}
          className={`${iconButton} ${layer.visible ? '' : 'text-faint'}`}
          onClick={(e) => {
            e.stopPropagation();
            void updatePixelLayer(texture.id, layer.id, { visible: !layer.visible });
          }}
        >
          {layer.visible ? <Eye size={14} strokeWidth={1.75} /> : <EyeOff size={14} strokeWidth={1.75} />}
        </button>
      </Tip>
      <Thumb url={thumbnail} />
      <span className={`min-w-0 flex-1 truncate text-[calc(12.5px*var(--font-scale))] ${layer.visible ? 'text-text' : 'text-faint'}`}>{layer.name}</span>
      {layer.opacity < 1 && <span className="tnum shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{Math.round(layer.opacity * 100)} %</span>}
    </li>
  );
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tip label={label}>
      <button aria-label={label} disabled={disabled} className={iconButton} onClick={onClick}>
        {children}
      </button>
    </Tip>
  );
}

function Layers({ texture }: { texture: Texture }) {
  const t = useT();
  const live = useLayerLive();
  const activeIds = usePixel((s) => s.activeLayer);
  const active = pixelLayer(texture, { activeLayer: activeIds });
  const layers = texture.layers ?? [];
  const image = useThumbnail(layers.length === 0 ? texture : undefined);
  const index = active ? layers.indexOf(active) : -1;
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-2.5">
      <div className="flex items-center gap-0.5">
        <h3 className={`${sectionTitle} flex-1`}>{t.paint.layers}</h3>
        <IconAction label={t.paint.addLayer} onClick={() => void addPixelLayer(texture)}>
          <Plus size={14} strokeWidth={1.75} />
        </IconAction>
        <IconAction label={t.paint.mergeDown} disabled={index < 1} onClick={() => active && void mergePixelLayerDown(texture, active.id)}>
          <ArrowDownToLine size={14} strokeWidth={1.75} />
        </IconAction>
        <IconAction label={t.paint.flatten} disabled={layers.length < 2} onClick={() => void flattenPixelLayers(texture)}>
          <Layers2 size={14} strokeWidth={1.75} />
        </IconAction>
        <IconAction label={t.paint.removeLayer} disabled={layers.length < 2 || !active} onClick={() => active && void removePixelLayer(texture, active.id)}>
          <Trash2 size={14} strokeWidth={1.75} />
        </IconAction>
      </div>
      {active && (
        // Keyed by the layer, so that a slider's own value while dragging never shows on another layer.
        <div key={active.id} className="grid grid-cols-2 gap-1">
          <PickMenu
            label={t.paint.blend}
            value={active.blend}
            placeholder=""
            options={blendModes.map((value) => ({ value, title: t.paint.blends[value] }))}
            onChange={(blend) => void updatePixelLayer(texture.id, active.id, { blend })}
          />
          <UnitSlider label={t.pixel.panel.opacity} value={active.opacity} onScrub={(opacity) => live.scrub({ textureId: texture.id, layerId: active.id, opacity })} onScrubEnd={live.end} />
        </div>
      )}
      {layers.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-9 items-center gap-1.5 rounded-md bg-raised pr-2 pl-2 shadow-[inset_0_0_0_1px_var(--line-strong)]">
            <Thumb url={image} />
            <span className="min-w-0 flex-1 truncate text-[calc(12.5px*var(--font-scale))] text-text">{t.paint.image}</span>
          </div>
          <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{t.pixel.panel.imageHint}</p>
        </div>
      ) : (
        <ul aria-label={t.paint.layers} className="flex flex-col gap-px">
          {[...layers].reverse().map((layer) => (
            <LayerRow key={layer.id} texture={texture} layer={layer} active={layer === active} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The right-hand panel of the pixel paint workspace: colours, the textures of the model, the layers and the animation of the painted one. */
export function PixelPanel() {
  const t = useT().pixel.panel;
  const texture = usePixelTexture();
  return (
    <section aria-label={t.title} className="flex min-h-0 min-w-0 flex-col border-t border-line">
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className={sectionTitle}>{t.title}</h2>
        <ImageMenu />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
        <ColorPanel />
        <Textures current={texture} />
        {texture && <Layers texture={texture} />}
        {texture && <AnimationPanel />}
      </div>
    </section>
  );
}
