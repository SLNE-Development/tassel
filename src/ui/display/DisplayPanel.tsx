import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { ClipboardPaste, Copy, FlipHorizontal2, RotateCcw, Save, Sparkles, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { selectDocState, useApp } from '../../app/store';
import {
  allPresets,
  displayRules,
  displaySlots,
  effectiveSlot,
  firstPersonPoses,
  frameReferences,
  groundReferences,
  guiReferences,
  shelfAlignments,
  shelfReferences,
  thirdPersonReferences,
  type DisplayPart,
  type DisplayPreset,
  type DisplaySlot,
} from '../../core/minecraft/display';
import type { Vec3 } from '../../core/types';
import { useT } from '../../i18n';
import { slotKind } from '../../viewport/display/DisplayView';
import { dispatch } from '../actions';
import { PickMenu, Segmented, Switch } from '../controls';
import { useLiveEdit } from '../live';
import { itemClass, popupClass } from '../menu';
import { FieldRow, smallButton } from '../minecraft/fields';
import { useMinecraftAssetsStatus } from '../preview/previewActions';
import { ScrubField } from '../ScrubField';
import { Tip } from '../Tip';
import { notifyError, notifySuccess } from '../toast';
import { useDisplayUi } from './displayStore';

const text = 'text-[calc(12.5px*var(--font-scale))]';
const setView = (changes: Record<string, unknown>) => void dispatch('display.set_view', changes);
const AXES = [
  { label: 'X', color: 'var(--axis-x, #e5484d)' },
  { label: 'Y', color: 'var(--axis-y, #46a758)' },
  { label: 'Z', color: 'var(--axis-z, #3e63dd)' },
];

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mt-3 mb-1.5 flex items-center justify-between border-t border-line pt-3">
      <h3 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{title}</h3>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function IconButton({ label, onClick, children, active, disabled }: { label: string; onClick(): void; children: ReactNode; active?: boolean; disabled?: boolean }) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        className={`flex size-6 items-center justify-center rounded-md ${active ? 'bg-raised text-accent' : 'text-dim hover:bg-raised hover:text-text'} disabled:pointer-events-none disabled:text-faint/50`}
        onClick={onClick}
      >
        {children}
      </button>
    </Tip>
  );
}

/** Slider plus numeric field for one axis of one part. */
function AxisRow({
  axis,
  value,
  min,
  max,
  step,
  label,
  onChange,
  onEnd,
  onCommit,
  extra,
}: {
  axis: number;
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange(value: number): void;
  onEnd(): void;
  onCommit(value: number): void;
  extra?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_4.75rem_auto] items-center gap-1.5">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        className="h-4 w-full min-w-0 cursor-pointer accent-[var(--accent)]"
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
      />
      <ScrubField
        label={AXES[axis].label}
        ariaLabel={label}
        color={AXES[axis].color}
        value={value}
        step={step}
        min={min}
        max={max}
        onCommit={onCommit}
        onScrub={onChange}
        onScrubEnd={onEnd}
      />
      {extra ?? <span className="w-6" />}
    </div>
  );
}

function PartEditor({ slot, part, value, version }: { slot: DisplaySlot; part: DisplayPart; value: Vec3; version: string }) {
  const t = useT().display;
  const live = useLiveEdit();
  const rules = displayRules(version);
  const isScale = part === 'scale';
  const [lo, hi] = isScale ? [0, rules.scale[1]] : rules[part];
  const title = t[part];
  const set = (axis: number, v: number): Vec3 => value.map((old, i) => (i === axis ? (isScale ? Math.sign(old || 1) * v : v) : old)) as Vec3;
  const params = (next: Vec3) => ({ slot, [part]: next });
  return (
    <>
      <Heading title={`${title} ${part === 'rotation' ? t.degrees : part === 'translation' ? t.pixels : ''}`.trim()}>
        <IconButton label={t.reset(title)} onClick={() => void dispatch('display.reset_slot', { slots: [slot], part })}>
          <RotateCcw size={13} strokeWidth={1.75} />
        </IconButton>
      </Heading>
      <div className="flex flex-col gap-1">
        {value.map((v, axis) => (
          <AxisRow
            key={axis}
            axis={axis}
            label={`${title} ${AXES[axis].label}`}
            value={isScale ? Math.abs(v) : v}
            min={lo}
            max={hi}
            step={part === 'rotation' ? 0.5 : part === 'translation' ? 0.25 : 0.01}
            onChange={(next) => live.scrub('display.set_slot', params(set(axis, next)))}
            onEnd={live.end}
            onCommit={(next) => void dispatch('display.set_slot', params(set(axis, next)))}
            extra={
              isScale ? (
                <IconButton
                  label={t.mirror(AXES[axis].label)}
                  active={v < 0}
                  onClick={() => void dispatch('display.set_slot', params(value.map((old, i) => (i === axis ? -old : old)) as Vec3))}
                >
                  <FlipHorizontal2 size={13} strokeWidth={1.75} />
                </IconButton>
              ) : undefined
            }
          />
        ))}
      </div>
    </>
  );
}

/** The reference options of the current kind of slot. */
function ReferenceOptions({ slot }: { slot: DisplaySlot }) {
  const t = useT().display;
  const prefs = useApp((s) => s.preferences);
  const guiLight = useApp((s) => selectDocState(s).java?.guiLight ?? 'side');
  const kind = slotKind(slot);
  const options = <T extends string>(values: readonly T[], titles: Record<T, string>) => values.map((value) => ({ value, title: titles[value] }));
  return (
    <div className="flex flex-col gap-1.5">
      {(kind === 'third' || kind === 'head') && (
        <>
          <FieldRow title={t.reference}>
            <PickMenu label={t.reference} value={prefs.displayThirdPerson} options={options(thirdPersonReferences, t.thirdPerson)} placeholder="" onChange={(v) => setView({ thirdPerson: v })} />
          </FieldRow>
          <FieldRow title={t.poseAngle}>
            <ScrubField
              wide
              label="°"
              ariaLabel={t.poseAngle}
              color="var(--faint)"
              value={kind === 'head' ? prefs.displayHeadAngle : prefs.displayHandAngle}
              step={0.5}
              min={kind === 'head' ? -90 : -90}
              max={kind === 'head' ? 90 : 180}
              onCommit={(v) => setView(kind === 'head' ? { headAngle: v } : { handAngle: v })}
              onScrub={(v) => setView(kind === 'head' ? { headAngle: v } : { handAngle: v })}
            />
          </FieldRow>
        </>
      )}
      {kind === 'first' && (
        <FieldRow title={t.reference}>
          <PickMenu label={t.reference} value={prefs.displayFirstPerson} options={options(firstPersonPoses, t.firstPerson)} placeholder="" onChange={(v) => setView({ firstPerson: v })} />
        </FieldRow>
      )}
      {kind === 'ground' && (
        <>
          <FieldRow title={t.reference}>
            <Segmented label={t.reference} value={prefs.displayGround} options={options(groundReferences, t.ground)} onChange={(v) => setView({ ground: v })} />
          </FieldRow>
          <div className="flex items-center justify-between">
            <span className={`${text} text-dim`}>{t.groundAnimation}</span>
            <Switch label={t.groundAnimation} checked={prefs.displayGroundAnimation} onChange={(v) => setView({ groundAnimation: v })} />
          </div>
        </>
      )}
      {kind === 'fixed' && (
        <FieldRow title={t.reference}>
          <PickMenu label={t.reference} value={prefs.displayFrame} options={options(frameReferences, t.frame)} placeholder="" onChange={(v) => setView({ frame: v })} />
        </FieldRow>
      )}
      {kind === 'shelf' && (
        <>
          <FieldRow title={t.reference}>
            <PickMenu label={t.reference} value={prefs.displayShelf} options={options(shelfReferences, t.shelf)} placeholder="" onChange={(v) => setView({ shelf: v })} />
          </FieldRow>
          <FieldRow title={t.shelfAlign}>
            <Segmented label={t.shelfAlign} value={prefs.displayShelfAlign} options={options(shelfAlignments, t.shelfAligns)} onChange={(v) => setView({ shelfAlign: v })} />
          </FieldRow>
        </>
      )}
      {kind === 'gui' && (
        <>
          <FieldRow title={t.reference}>
            <PickMenu label={t.reference} value={prefs.displayGui} options={options(guiReferences, t.gui)} placeholder="" onChange={(v) => setView({ gui: v })} />
          </FieldRow>
          <FieldRow title={t.guiLight}>
            <Segmented
              label={t.guiLight}
              value={guiLight}
              options={(['side', 'front'] as const).map((value) => ({ value, title: t.guiLights[value] }))}
              onChange={(light) => void dispatch('display.set_gui_light', { light })}
            />
          </FieldRow>
        </>
      )}
    </div>
  );
}

const presetName = (preset: DisplayPreset, t: ReturnType<typeof useT>['display']) =>
  preset.builtIn ? (t.builtInPresets[preset.id as keyof typeof t.builtInPresets] ?? preset.name) : preset.name;

function PresetMenu({ slot }: { slot: DisplaySlot }) {
  const t = useT().display;
  const user = useApp((s) => s.preferences.displayPresets);
  const presets = allPresets(user);
  const apply = (preset: DisplayPreset, only?: DisplaySlot[]) => void dispatch('display.apply_preset', { preset: preset.id, ...(only ? { slots: only } : {}) });
  return (
    <Menu.Root>
      <Menu.Trigger className={`${smallButton} flex-1`}>
        <Sparkles size={13} strokeWidth={1.75} />
        {t.applyPreset}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="start" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} max-h-80 overflow-y-auto`}>
            {presets.map((preset) => (
              <div key={preset.id} className="flex items-center">
                <Menu.Item className={`${itemClass} flex-1`} onClick={() => apply(preset)}>
                  <span className="truncate">{presetName(preset, t)}</span>
                </Menu.Item>
                {preset.slots[slot] && (
                  <Menu.Item className={`${itemClass} text-faint`} onClick={() => apply(preset, [slot])}>
                    {t.applyTo(t.slots[slot])}
                  </Menu.Item>
                )}
                {!preset.builtIn && (
                  <Menu.Item
                    aria-label={t.deletePreset(preset.name)}
                    className={`${itemClass} text-faint`}
                    onClick={() => void dispatch('display.delete_preset', { name: preset.name })}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                  </Menu.Item>
                )}
              </div>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function PresetDialog() {
  const t = useT().display;
  const open = useDisplayUi((s) => s.presetDialog);
  const current = useApp((s) => s.preferences.displaySlot);
  const [name, setName] = useState('');
  const [slots, setSlots] = useState<DisplaySlot[]>([]);
  const close = () => useDisplayUi.setState({ presetDialog: false });
  const save = async () => {
    try {
      await dispatch('display.save_preset', { name, slots });
      notifySuccess(name);
      close();
    } catch (error) {
      notifyError(error);
    }
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) return;
        setName('');
        setSlots([current]);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-fit w-[min(24rem,calc(100%-2rem))] flex-col gap-3 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop outline-none">
          <header className="flex items-center">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.presetDialog.title}</Dialog.Title>
            <Dialog.Close aria-label={t.presetDialog.cancel} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          <label className="flex flex-col gap-1">
            <span className={`${text} text-dim`}>{t.presetDialog.name}</span>
            <input
              autoFocus
              value={name}
              maxLength={60}
              className="h-7 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset focus:ring-accent"
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && slots.length > 0 && void save()}
            />
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className={`${text} mb-1 text-dim`}>{t.presetDialog.slots}</legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {displaySlots.map((slot) => (
                <label key={slot} className={`flex items-center gap-2 ${text} text-text`}>
                  <input
                    type="checkbox"
                    className="accent-[var(--accent)]"
                    checked={slots.includes(slot)}
                    onChange={(e) => setSlots((list) => (e.currentTarget.checked ? [...list, slot] : list.filter((s) => s !== slot)))}
                  />
                  {t.slots[slot]}
                </label>
              ))}
            </div>
          </fieldset>
          <p className={`${text} text-faint`}>{t.presetDialog.hint}</p>
          <div className="flex justify-end gap-2">
            <Dialog.Close className={smallButton}>{t.presetDialog.cancel}</Dialog.Close>
            <button className={smallButton} disabled={!name.trim() || slots.length === 0} onClick={() => void save()}>
              <Save size={13} strokeWidth={1.75} />
              {t.presetDialog.save}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The right-hand panel of the Display workspace: slot, reference scene, transform, presets. */
export function DisplayPanel() {
  const t = useT().display;
  const slot = useApp((s) => s.preferences.displaySlot);
  const java = useApp((s) => selectDocState(s).java);
  const clipboard = useDisplayUi((s) => s.clipboard);
  const assets = useMinecraftAssetsStatus();
  if (!java) return null;
  const { transform, source } = effectiveSlot(java.display, slot);
  const slots = displayRules(java.version).slots;
  return (
    <section aria-label={t.panel} className="flex min-h-0 min-w-0 flex-col border-t border-line">
      <header className="flex h-8 shrink-0 items-center justify-between px-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.panel}</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            label={t.copy}
            onClick={() => {
              useDisplayUi.setState({ clipboard: transform });
              notifySuccess(t.copied(t.slots[slot]));
            }}
          >
            <Copy size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={t.paste} disabled={!clipboard} onClick={() => clipboard && void dispatch('display.paste', { slots: [slot], transform: clipboard })}>
            <ClipboardPaste size={13} strokeWidth={1.75} />
          </IconButton>
          <IconButton label={t.resetSlot} onClick={() => void dispatch('display.reset_slot', { slots: [slot] })}>
            <RotateCcw size={13} strokeWidth={1.75} />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <div role="radiogroup" aria-label={t.panel} className="grid grid-cols-2 gap-1">
          {slots.map((s) => {
            const active = s === slot;
            const own = effectiveSlot(java.display, s).source === 'own';
            return (
              <button
                key={s}
                role="radio"
                aria-checked={active}
                className={`flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-left ${text} ${
                  active ? 'bg-raised text-text shadow-[0_0_0_1px_var(--line-strong)]' : 'text-dim hover:bg-raised/60 hover:text-text'
                }`}
                onClick={() => setView({ slot: s })}
              >
                <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${own ? 'bg-accent' : 'bg-line-strong'}`} />
                <span className="truncate">{t.slots[s]}</span>
              </button>
            );
          })}
        </div>
        <p className={`mt-2 ${text} text-faint`}>{t.source[source]}</p>
        <div className="mt-2 flex gap-1">
          <PresetMenu slot={slot} />
          <button className={smallButton} onClick={() => useDisplayUi.setState({ presetDialog: true })}>
            <Save size={13} strokeWidth={1.75} />
            {t.newPreset}
          </button>
        </div>

        <Heading title={t.reference} />
        <ReferenceOptions slot={slot} />

        <PartEditor slot={slot} part="rotation" value={transform.rotation} version={java.version} />
        <PartEditor slot={slot} part="translation" value={transform.translation} version={java.version} />
        <PartEditor slot={slot} part="scale" value={transform.scale} version={java.version} />

        <p className={`mt-4 ${text} leading-snug text-faint`}>{assets.state === 'ready' ? t.approx : t.noAssets}</p>
      </div>
      <PresetDialog />
    </section>
  );
}
