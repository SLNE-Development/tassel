import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Menu } from '@base-ui/react/menu';
import { Check, ChevronsUpDown, Copy, ImagePlus, Plus, Trash2, Unlink, X } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { execute, selectDocState, useApp } from '../app/store';
import { textureSlots, type Material, type Texture, type TextureSlot } from '../core/types';
import { useT } from '../i18n';
import { dispatch } from './actions';
import { ColorField, UnitSlider, useLive } from './materialControls';
import { itemClass, MenuSeparator, popupClass } from './menu';
import { ScrubField } from './ScrubField';
import { loadImageIntoSlot, setSlot, textureAccept, useThumbnail } from './textureFiles';
import { Tip } from './Tip';
import { notifyError } from './toast';

const iconButton =
  'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';

const selection = () => selectDocState(useApp.getState()).selection;

/**
 * Runs a command that gives objects a material. The first material assignment in a document
 * switches the viewport to material shading, so that the result is visible.
 */
async function assigning(run: () => Promise<unknown>): Promise<void> {
  const first = !Object.values(selectDocState(useApp.getState()).objects).some((o) => o.materialId !== null);
  try {
    await run();
    if (first && useApp.getState().shading !== 'material') await execute('view.set_shading', { shading: 'material' });
  } catch (error) {
    notifyError(error);
  }
}

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="size-3.5 shrink-0 rounded-[4px] ring-1 ring-line-strong ring-inset" style={{ background: color }} />;
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2">
      <span className="truncate text-[calc(12px*var(--font-scale))] text-dim">{title}</span>
      {children}
    </div>
  );
}

/** Asks before deleting a material that other objects still use. */
function DeleteDialog({ material, others, onClose }: { material: Material | null; others: number; onClose(): void }) {
  const t = useT();
  const buttonBase = 'h-8 rounded-md px-3.5 text-[calc(13px*var(--font-scale))] font-medium';
  return (
    <AlertDialog.Root open={material !== null} onOpenChange={(next) => !next && onClose()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Popup className="anim-pop fixed top-[24vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop">
          <AlertDialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.materials.deleteTitle}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">
            {material && t.materials.deleteText(material.name, others)}
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={`${buttonBase} mr-auto text-dim hover:bg-raised hover:text-text`}>{t.dialogs.cancel}</AlertDialog.Close>
            <button
              className={`${buttonBase} text-danger ring-1 ring-danger/40 ring-inset hover:bg-danger/12`}
              onClick={() => {
                onClose();
                if (material) void dispatch('material.delete', { id: material.id });
              }}
            >
              {t.materials.delete}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** The object's material and everything that can be done with the assignment. */
function Picker({ material }: { material: Material | undefined }) {
  const materials = useApp((s) => selectDocState(s).materials);
  const objects = useApp((s) => selectDocState(s).objects);
  const t = useT().materials;
  const [deleting, setDeleting] = useState<{ material: Material; others: number } | null>(null);

  const users = useMemo(() => {
    const counts = new Map<string, number>();
    for (const obj of Object.values(objects)) if (obj.materialId) counts.set(obj.materialId, (counts.get(obj.materialId) ?? 0) + 1);
    return counts;
  }, [objects]);
  const sorted = useMemo(() => Object.values(materials).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [materials]);

  const create = () => void assigning(() => execute('material.create', { name: t.title, assignTo: selection() }));
  const assign = (materialId: string | null) => void assigning(() => execute('material.assign', { materialId }));
  /** The copy replaces the original on the selected objects, so that it can be varied for them. */
  const duplicate = async (source: Material) => {
    try {
      const copy = (await execute('material.duplicate', { id: source.id })) as { id: string };
      await execute('material.assign', { materialId: copy.id });
    } catch (error) {
      notifyError(error);
    }
  };
  const remove = (target: Material) => {
    const selected = new Set(selection());
    const others = Object.values(objects).filter((o) => o.materialId === target.id && !selected.has(o.id)).length;
    if (others > 0) setDeleting({ material: target, others });
    else void dispatch('material.delete', { id: target.id });
  };

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          aria-label={`${t.pick}: ${material?.name ?? t.none}`}
          className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md bg-ink pr-1.5 pl-2 text-left text-[calc(12.5px*var(--font-scale))] ring-1 ring-line ring-inset hover:ring-line-strong data-[popup-open]:ring-accent"
        >
          {material && <Swatch color={material.baseColor} />}
          <span className={`min-w-0 flex-1 truncate ${material ? 'text-text' : 'text-faint'}`}>{material?.name ?? t.none}</span>
          <ChevronsUpDown size={12} className="shrink-0 text-faint" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
            <Menu.Popup className={`${popupClass} max-h-[min(24rem,var(--available-height))] w-[var(--anchor-width)] overflow-y-auto`}>
              {sorted.length > 0 && (
                <>
                  <Menu.RadioGroup value={material?.id ?? ''}>
                    {sorted.map((m) => (
                      <Menu.RadioItem key={m.id} className={itemClass} value={m.id} closeOnClick onClick={() => m.id !== material?.id && assign(m.id)}>
                        <span className="flex w-4 shrink-0 justify-center">
                          <Menu.RadioItemIndicator>
                            <Check size={14} strokeWidth={2.25} />
                          </Menu.RadioItemIndicator>
                        </span>
                        <Swatch color={m.baseColor} />
                        <span className="min-w-0 flex-1 truncate">{m.name}</span>
                        <span className="tnum shrink-0 pl-2 text-[calc(12px*var(--font-scale))] opacity-60">{t.usedBy(users.get(m.id) ?? 0)}</span>
                      </Menu.RadioItem>
                    ))}
                  </Menu.RadioGroup>
                  <MenuSeparator />
                </>
              )}
              <Menu.Item className={itemClass} onClick={create}>
                <span className="flex w-4 shrink-0 justify-center">
                  <Plus size={15} strokeWidth={1.75} />
                </span>
                {t.new}
              </Menu.Item>
              <Menu.Item className={itemClass} disabled={!material} onClick={() => material && void duplicate(material)}>
                <span className="flex w-4 shrink-0 justify-center">
                  <Copy size={15} strokeWidth={1.75} />
                </span>
                {t.duplicate}
              </Menu.Item>
              <Menu.Item className={itemClass} disabled={!material} onClick={() => void dispatch('material.assign', { materialId: null })}>
                <span className="flex w-4 shrink-0 justify-center">
                  <Unlink size={15} strokeWidth={1.75} />
                </span>
                {t.unassign}
              </Menu.Item>
              <Menu.Item className={itemClass} disabled={!material} onClick={() => material && remove(material)}>
                <span className="flex w-4 shrink-0 justify-center">
                  <Trash2 size={15} strokeWidth={1.75} />
                </span>
                {t.delete}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <DeleteDialog material={deleting?.material ?? null} others={deleting?.others ?? 0} onClose={() => setDeleting(null)} />
    </>
  );
}

function NameField({ material }: { material: Material }) {
  const reverting = useRef(false);
  const t = useT().materials;
  return (
    <input
      // Remount when the name changes from outside (undo, MCP), so the field never shows a stale value.
      key={material.name}
      aria-label={t.name}
      defaultValue={material.name}
      spellCheck={false}
      className="h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent"
      onBlur={(e) => {
        const next = e.currentTarget.value.trim();
        if (reverting.current || !next) e.currentTarget.value = material.name;
        else if (next !== material.name) void dispatch('material.update', { id: material.id, name: next });
        reverting.current = false;
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          reverting.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Thumbnail({ texture }: { texture: Texture | undefined }) {
  const url = useThumbnail(texture);
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-ink ring-1 ring-line ring-inset">
      {url && <img src={url} alt="" draggable={false} className="size-full object-cover" />}
    </span>
  );
}

/** One texture slot: what is in it, a menu to pick another texture of the document, load and clear. An image file can be dropped on it. */
function SlotRow({ material, slot }: { material: Material; slot: TextureSlot }) {
  const textures = useApp((s) => selectDocState(s).textures);
  const materials = useApp((s) => selectDocState(s).materials);
  const t = useT().materials;
  const input = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const title = t.slots[slot];
  const textureId = material.maps[slot];
  const texture = textureId === undefined ? undefined : textures[textureId];
  const sorted = useMemo(() => Object.values(textures).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [textures]);
  const unused = useMemo(() => {
    const used = new Set(Object.values(materials).flatMap((m) => Object.values(m.maps)));
    return Object.keys(textures).filter((id) => !used.has(id));
  }, [materials, textures]);

  const load = (file: File | undefined) => {
    if (file) loadImageIntoSlot(file, material.id, slot).catch(notifyError);
  };
  const clear = () => void setSlot(material.id, slot, null).catch(notifyError);
  const removeUnused = async () => {
    for (const id of unused) await dispatch('texture.remove', { id });
  };
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');

  return (
    <li
      aria-label={title}
      className={`flex h-9 items-center gap-0.5 rounded-md ${dropping ? 'bg-raised ring-1 ring-accent ring-inset' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        load(e.dataTransfer.files[0]);
      }}
    >
      <Menu.Root>
        <Menu.Trigger
          aria-label={t.slotTexture(title, texture?.name ?? t.noTexture)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-1 text-left hover:bg-raised data-[popup-open]:bg-raised"
        >
          <Thumbnail texture={texture} />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[calc(11.5px*var(--font-scale))] text-dim">{title}</span>
            <span className={`truncate text-[calc(12.5px*var(--font-scale))] ${texture ? 'text-text' : 'text-faint'}`}>{texture?.name ?? t.noTexture}</span>
          </span>
          <ChevronsUpDown size={12} className="shrink-0 text-faint" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
            <Menu.Popup className={`${popupClass} max-h-[min(22rem,var(--available-height))] overflow-y-auto`}>
              {sorted.length === 0 && <p className="px-2 py-1.5 text-[calc(12.5px*var(--font-scale))] text-faint">{t.noTextures}</p>}
              <Menu.RadioGroup value={texture?.id ?? ''}>
                {sorted.map((option) => (
                  <Menu.RadioItem
                    key={option.id}
                    className={itemClass}
                    value={option.id}
                    closeOnClick
                    onClick={() => option.id !== texture?.id && setSlot(material.id, slot, option.id).catch(notifyError)}
                  >
                    <span className="flex w-4 shrink-0 justify-center">
                      <Menu.RadioItemIndicator>
                        <Check size={14} strokeWidth={2.25} />
                      </Menu.RadioItemIndicator>
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    <span className="tnum shrink-0 pl-3 text-[calc(12px*var(--font-scale))] opacity-60">{t.pixels(option.width, option.height)}</span>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <MenuSeparator />
              <Menu.Item className={itemClass} onClick={() => input.current?.click()}>
                <span className="flex w-4 shrink-0 justify-center">
                  <ImagePlus size={15} strokeWidth={1.75} />
                </span>
                {t.loadImage}
              </Menu.Item>
              <Menu.Item className={itemClass} disabled={!texture} onClick={clear}>
                <span className="flex w-4 shrink-0 justify-center">
                  <X size={15} strokeWidth={1.75} />
                </span>
                {t.clearSlot}
              </Menu.Item>
              {unused.length > 0 && (
                <Menu.Item className={itemClass} onClick={() => void removeUnused()}>
                  <span className="flex w-4 shrink-0 justify-center">
                    <Trash2 size={15} strokeWidth={1.75} />
                  </span>
                  {t.removeUnused(unused.length)}
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Tip label={t.loadImage}>
        <button aria-label={t.loadImageFor(title)} className={iconButton} onClick={() => input.current?.click()}>
          <ImagePlus size={13} />
        </button>
      </Tip>
      <Tip label={t.clearSlot}>
        <button aria-label={t.clearSlotFor(title)} className={iconButton} disabled={!texture} onClick={clear}>
          <X size={13} />
        </button>
      </Tip>
      <input
        ref={input}
        type="file"
        hidden
        accept={textureAccept}
        aria-label={t.loadImageFor(title)}
        onChange={(e) => {
          load(e.currentTarget.files?.[0]);
          // So that choosing the same file again fires another change.
          e.currentTarget.value = '';
        }}
      />
    </li>
  );
}

function Editor({ objectId, material }: { objectId: string; material: Material }) {
  const unwrapped = useApp((s) => selectDocState(s).objects[objectId]?.mesh.uvs !== undefined);
  const live = useLive();
  const t = useT().materials;
  const id = material.id;
  const update = (change: Record<string, unknown>) => void dispatch('material.update', { id, ...change });
  const scrub = (change: Record<string, unknown>) => live.scrub('material.update', { id, ...change });
  const hasMaps = Object.keys(material.maps).length > 0;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 rounded-md bg-raised/45 p-2 ring-1 ring-line ring-inset">
      <NameField material={material} />
      <Row title={t.baseColor}>
        <ColorField label={t.baseColor} value={material.baseColor} onCommit={(baseColor) => update({ baseColor })} onScrub={(baseColor) => scrub({ baseColor })} onScrubEnd={live.end} />
      </Row>
      <UnitSlider label={t.metallic} value={material.metallic} onScrub={(metallic) => scrub({ metallic })} onScrubEnd={live.end} />
      <UnitSlider label={t.roughness} value={material.roughness} onScrub={(roughness) => scrub({ roughness })} onScrubEnd={live.end} />
      <Row title={t.emissive}>
        <ColorField label={t.emissive} value={material.emissive} onCommit={(emissive) => update({ emissive })} onScrub={(emissive) => scrub({ emissive })} onScrubEnd={live.end} />
      </Row>
      <ScrubField
        wide
        label={t.strength}
        ariaLabel={t.emissiveStrength}
        color="var(--dim)"
        value={material.emissiveStrength}
        step={0.01}
        min={0}
        max={100}
        onCommit={(emissiveStrength) => update({ emissiveStrength })}
        onScrub={(emissiveStrength) => void scrub({ emissiveStrength })}
        onScrubEnd={live.end}
      />

      <h4 className="mt-1 border-t border-line pt-2 text-[calc(12px*var(--font-scale))] text-dim">{t.maps}</h4>
      <ul aria-label={t.maps} className="-mx-1 flex flex-col">
        {textureSlots.map((slot) => (
          <SlotRow key={slot} material={material} slot={slot} />
        ))}
      </ul>
      {material.maps.normal !== undefined && (
        <ScrubField
          wide
          label={t.normalScale}
          ariaLabel={t.normalScale}
          color="var(--dim)"
          value={material.normalScale}
          step={0.01}
          min={0}
          max={10}
          onCommit={(normalScale) => update({ normalScale })}
          onScrub={(normalScale) => void scrub({ normalScale })}
          onScrubEnd={live.end}
        />
      )}
      {hasMaps && !unwrapped && (
        <div role="note" className="mt-0.5 flex flex-col items-start gap-1.5 rounded-md bg-ink px-2 py-1.5 ring-1 ring-line ring-inset">
          <p className="text-[calc(12px*var(--font-scale))] leading-snug text-dim">{t.noUvs}</p>
          <button
            className="h-6 rounded-md px-2 text-[calc(12px*var(--font-scale))] text-text ring-1 ring-line-strong ring-inset hover:bg-raised hover:ring-faint"
            onClick={() => void dispatch('uv.unwrap', { objectId, method: 'smart' })}
          >
            {t.unwrap}
          </button>
        </div>
      )}
    </div>
  );
}

/** The active object's material: which one it has, and that material's values and texture maps. */
export function Materials({ id }: { id: string }) {
  const material = useApp((s) => {
    const state = selectDocState(s);
    const materialId = state.objects[id]?.materialId;
    return materialId ? state.materials[materialId] : undefined;
  });
  const exists = useApp((s) => selectDocState(s).objects[id] !== undefined);
  const t = useT().materials;
  if (!exists) return null;
  return (
    <div>
      <h3 className="mb-1.5 border-t border-line pt-3 text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.title}</h3>
      <Picker material={material} />
      {material ? (
        // Keyed by the material, so that drafts of one material never show on another.
        <Editor key={material.id} objectId={id} material={material} />
      ) : (
        <p className="mt-1.5 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{t.empty}</p>
      )}
    </div>
  );
}
