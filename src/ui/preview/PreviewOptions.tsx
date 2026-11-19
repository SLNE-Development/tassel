import { Popover } from '@base-ui/react/popover';
import { Camera, ImagePlus, Save, SlidersHorizontal, Trash2, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApp } from '../../app/store';
import { anglePresets, basicScenes, isMinecraftScene, minecraftScenes, previewBackgrounds, projections, type PreviewScene } from '../../core/preview';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu, Segmented, Switch } from '../controls';
import { popupClass } from '../menu';
import { Tip } from '../Tip';
import { useUi } from '../uiStore';
import { chooseSkin, setAngle, useMinecraftAssetsStatus } from './previewActions';

const setPreview = (changes: object) => void dispatch('view.set_preview', changes);

const text = 'text-[calc(12.5px*var(--font-scale))]';
const smallButton = `flex h-7 min-w-0 items-center justify-center gap-1.5 truncate rounded-md bg-ink px-2 ${text} text-dim ring-1 ring-line ring-inset hover:text-text hover:ring-line-strong`;

function Heading({ children }: { children: ReactNode }) {
  return <h3 className="mt-1 mb-1.5 font-display text-[calc(12px*var(--font-scale))] font-semibold text-dim uppercase">{children}</h3>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3">
      <span className={`min-w-0 flex-1 truncate ${text} text-text`}>{label}</span>
      {children}
    </div>
  );
}

/** Says when a Minecraft scene or reference model has to make do with flat colours. */
function AssetsNote({ needed }: { needed: boolean }) {
  const t = useT().preview;
  const status = useMinecraftAssetsStatus();
  if (!needed || status.state === 'ready') return null;
  const message = status.state === 'loading' ? t.assetsLoading : status.state === 'error' ? t.assetsError : t.noAssets;
  return (
    <div className={`mt-1.5 flex items-start gap-2 rounded-md bg-ink px-2 py-1.5 ${text} text-dim ring-1 ring-line ring-inset`}>
      <TriangleAlert size={13} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 flex-1">{message}</span>
      {status.state !== 'loading' && (
        <button className="shrink-0 text-accent hover:underline" onClick={() => useUi.setState({ preferencesOpen: true })}>
          {t.setUpAssets}
        </button>
      )}
    </div>
  );
}

function SavedAngles() {
  const t = useT().preview;
  const angles = useApp((s) => s.preferences.cameraAngles);
  const [name, setName] = useState<string | null>(null);
  const save = () => {
    if (name?.trim()) void dispatch('view.save_angle', { name: name.trim() });
    setName(null);
  };
  return (
    <>
      <div className="mt-2 mb-1 flex items-center">
        <span className={`flex-1 ${text} text-dim`}>{t.saved}</span>
        {name === null && (
          <button className={`${smallButton} h-6`} onClick={() => setName('')}>
            <Save size={12} />
            {t.saveAngle}
          </button>
        )}
      </div>
      {name !== null && (
        <form
          className="mb-1 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            aria-label={t.angleName}
            placeholder={t.angleName}
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Escape' && (event.stopPropagation(), setName(null))}
            className={`h-7 min-w-0 flex-1 rounded-md bg-ink px-2 ${text} text-text ring-1 ring-line outline-none ring-inset focus:ring-accent`}
          />
          <button type="submit" disabled={!name.trim()} className={`${smallButton} disabled:opacity-50`}>
            {t.save}
          </button>
        </form>
      )}
      {angles.length === 0 ? (
        <p className={`${text} text-faint`}>{t.noSaved}</p>
      ) : (
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
          {angles.map((angle) => (
            <li key={angle.name} className="group flex items-center gap-1">
              <button
                className={`flex h-6 min-w-0 flex-1 items-center gap-2 rounded-[5px] px-1.5 text-left ${text} text-text hover:bg-raised`}
                onClick={() => void dispatch('view.set_angle', { name: angle.name })}
              >
                <Camera size={12} className="shrink-0 text-faint" />
                <span className="truncate">{angle.name}</span>
              </button>
              <button
                aria-label={t.deleteAngle(angle.name)}
                title={t.deleteAngle(angle.name)}
                className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-faint opacity-0 group-hover:opacity-100 hover:bg-raised hover:text-text focus-visible:opacity-100"
                onClick={() => void dispatch('view.delete_angle', { name: angle.name })}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function PreviewOptionsBody() {
  const t = useT().preview;
  const p = useApp((s) => s.preferences);
  const sceneOptions = [...basicScenes, ...minecraftScenes].map((scene: PreviewScene) => ({ value: scene, title: t.scenes[scene] }));
  const needsAssets = isMinecraftScene(p.previewScene) || p.previewPlayer || p.previewCraftingTable;
  const skinName = p.previewSkin ? (p.previewSkin.split(/[\\/]/).pop() ?? p.previewSkin) : t.skinDefault;
  return (
    <div className="flex flex-col gap-1.5 p-2.5">
      <Heading>{t.scene}</Heading>
      <PickMenu label={t.scene} value={p.previewScene} options={sceneOptions} placeholder={t.scenes.none} onChange={(scene) => setPreview({ scene })} />

      <Heading>{t.background}</Heading>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Segmented
            label={t.background}
            value={p.previewBackground}
            options={previewBackgrounds.map((value) => ({ value, title: t.backgrounds[value] }))}
            onChange={(background) => setPreview({ background })}
          />
        </div>
        <label title={t.backgroundColor} className="relative size-7 shrink-0 cursor-pointer rounded-md ring-1 ring-line-strong ring-inset" style={{ background: p.previewBackgroundColor }}>
          <input
            type="color"
            aria-label={t.backgroundColor}
            className="absolute inset-0 size-full cursor-pointer opacity-0"
            value={p.previewBackgroundColor}
            onChange={(event) => setPreview({ backgroundColor: event.currentTarget.value })}
          />
        </label>
      </div>
      {p.previewScene !== 'none' && <p className={`${text} text-faint`}>{t.backgroundHint}</p>}
      <Row label={t.ground}>
        <Switch checked={p.previewGround} label={t.ground} onChange={(ground) => setPreview({ ground })} />
      </Row>
      <Row label={t.pixelGrid}>
        <Switch checked={p.previewPixelGrid} label={t.pixelGrid} onChange={(pixelGrid) => setPreview({ pixelGrid })} />
      </Row>

      <Heading>{t.references}</Heading>
      <Row label={t.player}>
        <Switch checked={p.previewPlayer} label={t.player} onChange={(player) => setPreview({ player })} />
      </Row>
      {p.previewPlayer && (
        <div className="flex items-center gap-1.5 pl-3">
          <span className={`min-w-0 flex-1 truncate ${text} text-dim`} title={p.previewSkin || undefined}>
            {t.skin}: {skinName}
          </span>
          {p.previewSkin && (
            <button className={`${smallButton} h-6`} onClick={() => setPreview({ skin: '' })}>
              {t.skinDefault}
            </button>
          )}
          <button className={`${smallButton} h-6`} onClick={() => void chooseSkin()}>
            <ImagePlus size={12} />
            {t.chooseSkin}
          </button>
        </div>
      )}
      <Row label={t.craftingTable}>
        <Switch checked={p.previewCraftingTable} label={t.craftingTable} onChange={(craftingTable) => setPreview({ craftingTable })} />
      </Row>
      <AssetsNote needed={needsAssets} />

      <Heading>{t.camera}</Heading>
      <Segmented
        label={t.projection}
        value={p.viewportProjection}
        options={projections.map((value) => ({ value, title: t.projections[value] }))}
        onChange={(projection) => void dispatch('view.set_projection', { projection })}
      />
      {/* Sides in a grid, the longer isometric names one per row. */}
      {[anglePresets.filter((p) => !p.includes('iso')), anglePresets.filter((p) => p.includes('iso'))].map((presets, i) => (
        <div key={i} className={`grid gap-1 ${i === 0 ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {presets.map((preset) => (
            <button key={preset} className={smallButton} title={t.angles[preset]} onClick={() => void setAngle(preset)}>
              {t.angles[preset]}
            </button>
          ))}
        </div>
      ))}
      <SavedAngles />
    </div>
  );
}

/** The "Preview options" button in the viewport's top right corner and its popover. */
export function PreviewOptions() {
  const t = useT().preview;
  const active = useApp((s) => s.preferences.previewScene !== 'none' || s.preferences.previewPlayer || s.preferences.previewCraftingTable);
  return (
    <div className="absolute top-3 right-3">
      <Popover.Root>
        <Tip label={t.button}>
          <Popover.Trigger
            aria-label={t.button}
            className={`flex size-7 items-center justify-center rounded-lg border border-line bg-panel/90 backdrop-blur-sm hover:text-text data-[popup-open]:text-accent ${active ? 'text-accent' : 'text-dim'}`}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-40 outline-none">
            <Popover.Popup aria-label={t.button} className={`${popupClass} max-h-[calc(100vh-8rem)] w-72 overflow-y-auto p-0`}>
              <PreviewOptionsBody />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
