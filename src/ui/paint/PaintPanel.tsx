import { ArrowDownToLine, Eye, EyeOff, Layers2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { blendModes, type PaintLayer, type Texture } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch, getAction, runAction, shortcutLabel } from '../actions';
import { PickMenu, Segmented } from '../controls';
import { LiveEdit } from '../live';
import { UnitSlider } from '../materialControls';
import { ScrubField } from '../ScrubField';
import { useThumbnail } from '../textureFiles';
import { Tip } from '../Tip';
import { textureBlob } from '../../viewport/textureImage';
import { createMaterial, createTexture, moveLayer, normalFromHeight, selectLayer, unwrapTarget, updateLayer } from './paintActions';
import { paintSlots, textureSizes, usePaint, usePaintTarget, type PaintTarget } from './paintStore';

const iconButton =
  'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const primaryButton = 'h-8 rounded-md bg-accent px-3.5 text-[calc(13px*var(--font-scale))] font-medium text-accent-ink hover:brightness-110';
const quietButton =
  'h-7 rounded-md px-2.5 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line-strong ring-inset hover:bg-raised hover:ring-faint disabled:pointer-events-none disabled:text-faint';
const sectionTitle = 'text-[calc(12px*var(--font-scale))] font-semibold text-dim';
/** Transparency shows as a quiet checker in both themes. */
const checker = {
  backgroundImage: 'repeating-conic-gradient(var(--line-strong) 0% 25%, var(--raised) 0% 50%)',
  backgroundSize: '8px 8px',
};

// --- Layer thumbnails ------------------------------------------------------------------------

const THUMBNAIL_SIZE = 56;
const THUMBNAILS_KEPT = 48;
/** Small previews by the layer's PNG text: a layer keeps its image while only its opacity or name changes. */
const thumbnails = new Map<string, string | Promise<string>>();

async function makeThumbnail(data: string, width: number, height: number): Promise<string> {
  const scale = THUMBNAIL_SIZE / Math.max(width, height);
  const size = { resizeWidth: Math.max(1, Math.round(width * scale)), resizeHeight: Math.max(1, Math.round(height * scale)) };
  // The browser scales while decoding; the full-size image is never kept.
  const bitmap = await createImageBitmap(textureBlob({ data, mimeType: 'image/png' } as Texture), { ...size, resizeQuality: 'medium' });
  const canvas = document.createElement('canvas');
  canvas.width = size.resizeWidth;
  canvas.height = size.resizeHeight;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

function useLayerThumbnail(layer: PaintLayer, texture: Texture): string | null {
  const { data } = layer;
  const [, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (typeof thumbnails.get(data) === 'string') return;
    let pending = thumbnails.get(data) as Promise<string> | undefined;
    if (!pending) {
      pending = makeThumbnail(data, texture.width, texture.height);
      thumbnails.set(data, pending);
      pending.then(
        (url) => {
          thumbnails.set(data, url);
          // The oldest go first; a layer that is still shown simply makes its preview again.
          for (const key of thumbnails.keys()) {
            if (thumbnails.size <= THUMBNAILS_KEPT) break;
            thumbnails.delete(key);
          }
        },
        () => thumbnails.delete(data),
      );
    }
    let mounted = true;
    pending.then(
      () => mounted && setReady(data),
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [data, texture.width, texture.height]);
  const cached = thumbnails.get(data);
  return typeof cached === 'string' ? cached : null;
}

function Thumb({ url }: { url: string | null }) {
  return (
    <span aria-hidden className="size-7 shrink-0 overflow-hidden rounded-[5px] ring-1 ring-line-strong ring-inset" style={checker}>
      {url && <img src={url} alt="" draggable={false} className="size-full object-cover" />}
    </span>
  );
}

// --- What is missing -------------------------------------------------------------------------

function Fix({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <div role="note" className="flex flex-col items-start gap-2 rounded-md bg-ink px-2.5 py-2.5 ring-1 ring-line ring-inset">
      <div>
        <p className="text-[calc(13px*var(--font-scale))] font-medium text-text">{title}</p>
        <p className="mt-0.5 text-[calc(12.5px*var(--font-scale))] leading-snug text-dim">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function Problem({ target }: { target: PaintTarget }) {
  const size = usePaint((s) => s.textureSize);
  const t = useT().paint;
  const name = target.object?.name ?? '';
  switch (target.problem) {
    case 'noObject':
      return <Fix title={t.noObject} hint={t.noObjectHint} />;
    case 'editMode':
      return (
        <Fix title={t.editMode} hint={t.editModeHint}>
          <button className={primaryButton} onClick={() => void dispatch('edit.exit')}>
            {t.exitEdit}
          </button>
        </Fix>
      );
    case 'noMaterial':
      return (
        <Fix title={t.noMaterial(name)} hint={t.noMaterialHint}>
          <button className={primaryButton} onClick={() => void createMaterial()}>
            {t.createMaterial}
          </button>
        </Fix>
      );
    case 'noUvs':
      return (
        <Fix title={t.noUvs(name)} hint={t.noUvsHint}>
          <button className={primaryButton} onClick={() => void unwrapTarget()}>
            {t.unwrap}
          </button>
        </Fix>
      );
    case 'noTexture':
      return (
        <Fix title={t.noTexture(t.slots[target.slot])} hint={target.slot === 'height' ? t.heightHint : t.noTextureHint}>
          <div className="w-full">
            <Segmented label={t.textureSize} value={size} options={textureSizes.map((value) => ({ value, title: String(value) }))} onChange={(textureSize) => usePaint.setState({ textureSize })} />
          </div>
          <button className={primaryButton} onClick={() => void createTexture()}>
            {t.createTexture}
          </button>
        </Fix>
      );
    default:
      return null;
  }
}

// --- Target ----------------------------------------------------------------------------------

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[calc(12px*var(--font-scale))] text-dim">{title}</span>
      {children}
    </div>
  );
}

function Target({ target }: { target: PaintTarget }) {
  const t = useT();
  const { material, texture, slot } = target;
  const thumbnail = useThumbnail(texture);
  if (!material) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Row title={t.materials.title}>
        <span className="flex h-7 min-w-0 items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-text">
          <span aria-hidden className="size-3.5 shrink-0 rounded-[4px] ring-1 ring-line-strong ring-inset" style={{ background: material.baseColor }} />
          <span className="truncate">{material.name}</span>
        </span>
      </Row>
      <Row title={t.paint.slot}>
        <PickMenu label={t.paint.slot} value={slot} placeholder="" options={paintSlots.map((value) => ({ value, title: t.paint.slots[value] }))} onChange={(next) => usePaint.setState({ slot: next })} />
      </Row>
      {texture && !target.problem && (
        <div className="mt-0.5 flex min-w-0 items-center gap-2">
          <Thumb url={thumbnail} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[calc(12.5px*var(--font-scale))] text-text">{texture.name}</span>
            <span className="tnum text-[calc(11.5px*var(--font-scale))] text-faint">{t.paint.pixels(texture.width, texture.height)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

/** The height texture is not bound to the material; a normal map generated from it is. */
function Height() {
  const [strength, setStrength] = useState(2);
  const t = useT().paint;
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-ink px-2.5 py-2 ring-1 ring-line ring-inset">
      <p className="text-[calc(12px*var(--font-scale))] leading-snug text-dim">{t.heightPreview}</p>
      <div className="flex items-center gap-1.5">
        <div className="w-24 shrink-0">
          <ScrubField wide label={t.normalStrength} ariaLabel={t.normalStrength} color="var(--dim)" value={strength} step={0.05} min={0.01} max={50} onCommit={setStrength} />
        </div>
        <button className={`${quietButton} min-w-0 flex-1 truncate`} onClick={() => void normalFromHeight(strength)}>
          {t.normalFromHeight}
        </button>
      </div>
    </div>
  );
}

// --- Layers ----------------------------------------------------------------------------------

/**
 * Live changes of a layer value through `paint.update_layer`, one undo step per drag. The command
 * re-encodes the texture, so it is still running when the next drag (or key press) starts: that one
 * waits for it instead of running into it.
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

function ActionButton({ id, icon, disabled }: { id: string; icon: ReactNode; disabled?: boolean }) {
  const { title } = getAction(id);
  return (
    <Tip label={title} shortcut={shortcutLabel(id)}>
      <button aria-label={title} disabled={disabled} className={iconButton} onClick={() => void runAction(id)}>
        {icon}
      </button>
    </Tip>
  );
}

function LayerRow({
  texture,
  layer,
  active,
  drop,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  texture: Texture;
  layer: PaintLayer;
  active: boolean;
  /** Where a dragged layer would land relative to this row. */
  drop: 'above' | 'below' | null;
  onDragStart(): void;
  onDragOver(event: DragEvent<HTMLLIElement>): void;
  onDrop(): void;
  onDragEnd(): void;
}) {
  const thumbnail = useLayerThumbnail(layer, texture);
  const [renaming, setRenaming] = useState(false);
  const reverting = useRef(false);
  const t = useT().paint;
  const toggle = layer.visible ? t.hideLayer(layer.name) : t.showLayer(layer.name);
  return (
    <li
      draggable={!renaming}
      aria-current={active}
      className={`relative flex h-9 items-center gap-1.5 rounded-md pr-2 pl-0.5 ${active ? 'bg-raised shadow-[inset_0_0_0_1px_var(--line-strong)]' : 'hover:bg-raised/50'}`}
      onClick={() => selectLayer(texture.id, layer.id)}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', layer.name);
        onDragStart();
      }}
      onDragOver={onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={onDragEnd}
    >
      {drop && <span aria-hidden className={`pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-accent ${drop === 'above' ? '-top-px' : '-bottom-px'}`} />}
      {active && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent" />}
      <Tip label={toggle} side="left">
        <button
          aria-label={toggle}
          aria-pressed={layer.visible}
          className={`${iconButton} ${layer.visible ? '' : 'text-faint'}`}
          onClick={(e) => {
            e.stopPropagation();
            void updateLayer(texture.id, layer.id, { visible: !layer.visible });
          }}
        >
          {layer.visible ? <Eye size={14} strokeWidth={1.75} /> : <EyeOff size={14} strokeWidth={1.75} />}
        </button>
      </Tip>
      <Thumb url={thumbnail} />
      {renaming ? (
        <input
          autoFocus
          aria-label={t.renameLayer}
          defaultValue={layer.name}
          spellCheck={false}
          className="h-6 w-full min-w-0 rounded bg-ink px-1.5 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-accent outline-none ring-inset"
          onFocus={(e) => e.currentTarget.select()}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const next = e.currentTarget.value.trim();
            if (!reverting.current && next && next !== layer.name) void updateLayer(texture.id, layer.id, { name: next });
            reverting.current = false;
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              reverting.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate text-[calc(12.5px*var(--font-scale))] ${layer.visible ? 'text-text' : 'text-faint'}`} onDoubleClick={() => setRenaming(true)}>
          {layer.name}
        </span>
      )}
      {!renaming && layer.opacity < 1 && <span className="tnum shrink-0 text-[calc(11.5px*var(--font-scale))] text-faint">{Math.round(layer.opacity * 100)} %</span>}
    </li>
  );
}

function Layers({ texture, active }: { texture: Texture; active: PaintLayer | undefined }) {
  const t = useT().paint;
  const live = useLayerLive();
  const layers = texture.layers ?? [];
  const image = useThumbnail(layers.length === 0 ? texture : undefined);
  /** The dragged layer and the gap it would drop into: 0 is above the top layer. */
  const [drag, setDrag] = useState<{ id: string; gap: number | null } | null>(null);
  // Shown top first, as they are stacked.
  const shown = [...layers].reverse();
  const index = active ? layers.indexOf(active) : -1;

  const drop = () => {
    if (!drag || drag.gap === null) return;
    const from = shown.findIndex((l) => l.id === drag.id);
    // The gap counts rows including the dragged one; taking that row out shifts the gaps below it.
    const position = drag.gap > from ? drag.gap - 1 : drag.gap;
    if (from >= 0 && position !== from) void moveLayer(texture.id, drag.id, layers.length - 1 - position);
    setDrag(null);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-0.5 border-t border-line pt-2.5">
        <h3 className={`${sectionTitle} flex-1`}>{t.layers}</h3>
        <ActionButton id="paint.add_layer" icon={<Plus size={14} strokeWidth={1.75} />} />
        <ActionButton id="paint.merge_down" icon={<ArrowDownToLine size={14} strokeWidth={1.75} />} disabled={index < 1} />
        <ActionButton id="paint.flatten" icon={<Layers2 size={14} strokeWidth={1.75} />} disabled={layers.length < 2} />
        <ActionButton id="paint.remove_layer" icon={<Trash2 size={14} strokeWidth={1.75} />} disabled={layers.length < 2} />
      </div>
      {active && (
        // Keyed by the layer, so that a slider's own value while dragging never shows on another layer.
        <div key={active.id} className="grid grid-cols-2 gap-1">
          <PickMenu label={t.blend} value={active.blend} placeholder="" options={blendModes.map((value) => ({ value, title: t.blends[value] }))} onChange={(blend) => void updateLayer(texture.id, active.id, { blend })} />
          <UnitSlider label={t.opacity} value={active.opacity} onScrub={(opacity) => live.scrub({ textureId: texture.id, layerId: active.id, opacity })} onScrubEnd={live.end} />
        </div>
      )}
      {layers.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex h-9 items-center gap-1.5 rounded-md bg-raised pr-2 pl-7.5 shadow-[inset_0_0_0_1px_var(--line-strong)]">
            <Thumb url={image} />
            <span className="min-w-0 flex-1 truncate text-[calc(12.5px*var(--font-scale))] text-text">{t.image}</span>
          </div>
          <p className="text-[calc(12px*var(--font-scale))] leading-snug text-faint">{t.imageHint}</p>
        </div>
      ) : (
        <ul aria-label={t.layers} className="flex flex-col gap-px" onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag((d) => d && { ...d, gap: null })}>
          {shown.map((layer, row) => (
            <LayerRow
              key={layer.id}
              texture={texture}
              layer={layer}
              active={layer === active}
              drop={drag && drag.gap === row ? 'above' : drag && drag.gap === row + 1 && row === shown.length - 1 ? 'below' : null}
              onDragStart={() => setDrag({ id: layer.id, gap: null })}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const gap = e.clientY < rect.top + rect.height / 2 ? row : row + 1;
                if (gap !== drag.gap) setDrag({ ...drag, gap });
              }}
              onDrop={drop}
              onDragEnd={() => setDrag(null)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** The right-hand panel of the paint workspace: what is painted on, and the texture's layers. */
export function PaintPanel() {
  const target = usePaintTarget();
  const t = useT();
  const { texture, problem } = target;
  return (
    <section aria-label={t.paint.panel} className="flex min-h-0 min-w-0 flex-col border-t border-line">
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 px-3">
        <h2 className={sectionTitle}>{t.paint.panel}</h2>
        {target.object && <span className="min-w-0 truncate text-[calc(12px*var(--font-scale))] text-faint">{target.object.name}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
        <Target target={target} />
        {problem && <Problem target={target} />}
        {!problem && texture && target.slot === 'height' && <Height />}
        {!problem && texture && <Layers texture={texture} active={target.layer} />}
      </div>
    </section>
  );
}
