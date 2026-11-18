import { Dialog } from '@base-ui/react/dialog';
import { Slider } from '@base-ui/react/slider';
import { Check, Pipette, RotateCcw, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useApp } from '../app/store';
import { defaultPreferences, type Preferences as PreferenceValues } from '../core/preferences';
import { useT } from '../i18n';
import { dispatch } from './actions';
import { Segmented, Switch } from './controls';
import { ScrubField } from './ScrubField';
import { useUi } from './uiStore';

const set = (changes: Partial<PreferenceValues>) => void dispatch('preferences.set', changes);

const accentPresets = [
  { color: '#e9b949', key: 'brass' },
  { color: '#e08a5b', key: 'copper' },
  { color: '#5fb5a3', key: 'patina' },
  { color: '#6aa3e8', key: 'steel' },
  { color: '#b79ae6', key: 'heather' },
  { color: '#9cc25a', key: 'moss' },
] as const;

// Discrete steps: the dialog itself rescales under the pointer, so a slider would chase its own thumb.
const uiScales = [0.75, 0.9, 1, 1.1, 1.25, 1.5];

const percent = (value: number) => `${Math.round(value * 100)} %`;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-5 pt-3.5 pb-4 first:border-t-0">
      <h3 className="mb-2.5 font-display text-[calc(13px*var(--font-scale))] font-semibold text-text">{title}</h3>
      <div className="grid grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="text-[calc(12.5px*var(--font-scale))] text-dim">{label}</span>
      <div className="flex min-h-7 min-w-0 items-center justify-end gap-2">{children}</div>
    </>
  );
}

// Miniature of the shell in each theme. These are pictures of the themes, so the colours are fixed.
const themeTiles = [
  { value: 'dark', stage: '#14181a', panel: '#232a2e', accent: '#e9b949' },
  { value: 'light', stage: '#cdccc3', panel: '#f6f5f0', accent: '#8c6f2c' },
  { value: 'system', stage: '', panel: '', accent: '' },
] as const;

function ThemeMiniature({ stage, panel, accent }: { stage: string; panel: string; accent: string }) {
  return (
    <span aria-hidden className="flex h-full flex-1 gap-px" style={{ background: stage }}>
      <span className="m-1 mt-auto h-1 w-3 rounded-full" style={{ background: accent }} />
      <span className="ml-auto h-full w-2.5" style={{ background: panel }} />
    </span>
  );
}

function ThemePicker({ value }: { value: PreferenceValues['theme'] }) {
  const t = useT().preferences;
  return (
    <div role="radiogroup" aria-label={t.theme} className="grid w-full grid-cols-3 gap-2">
      {themeTiles.map((tile) => {
        const active = tile.value === value;
        return (
          <button
            key={tile.value}
            role="radio"
            aria-checked={active}
            className={`flex min-w-0 flex-col overflow-hidden rounded-md text-[calc(12px*var(--font-scale))] ring-1 ring-inset ${
              active ? 'bg-raised text-text ring-accent' : 'bg-ink text-dim ring-line hover:text-text hover:ring-line-strong'
            }`}
            onClick={() => !active && set({ theme: tile.value })}
          >
            <span className="m-px mb-0 flex h-8 overflow-hidden rounded-t-[5px]">
              {tile.value === 'system' ? (
                <>
                  <ThemeMiniature {...themeTiles[0]} />
                  <ThemeMiniature {...themeTiles[1]} />
                </>
              ) : (
                <ThemeMiniature {...tile} />
              )}
            </span>
            <span className="truncate px-1 py-1">{t.themes[tile.value]}</span>
          </button>
        );
      })}
    </div>
  );
}

function AccentPicker({ value }: { value: string }) {
  const t = useT().preferences;
  const custom = !accentPresets.some((preset) => preset.color === value.toLowerCase());
  const swatch = 'relative flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-black/20 ring-inset';
  const selected = 'outline-2 outline-offset-2 outline-text';
  return (
    <div role="radiogroup" aria-label={t.accent} className="flex flex-wrap items-center justify-end gap-2.5">
      {accentPresets.map((preset) => {
        const active = preset.color === value.toLowerCase();
        return (
          <button
            key={preset.color}
            role="radio"
            aria-checked={active}
            aria-label={t.accents[preset.key]}
            title={t.accents[preset.key]}
            className={`${swatch} ${active ? selected : ''}`}
            style={{ background: preset.color }}
            onClick={() => !active && set({ accentColor: preset.color })}
          >
            {active && <Check size={13} strokeWidth={2.75} color="#1b1604" />}
          </button>
        );
      })}
      <label
        title={t.accentCustom}
        className={`${swatch} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${custom ? selected : 'bg-ink text-dim hover:text-text'}`}
        style={custom ? { background: value } : undefined}
      >
        <Pipette size={12} strokeWidth={2} color={custom ? '#1b1604' : undefined} />
        <input
          type="color"
          aria-label={t.accentCustom}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
          value={value}
          onChange={(event) => set({ accentColor: event.currentTarget.value })}
        />
      </label>
    </div>
  );
}

/**
 * Slider with a readout. `live` writes the preference on every change; otherwise the value is
 * written once on release, for settings that would move the slider itself (text size).
 */
function PreferenceSlider({
  label,
  value,
  min,
  max,
  step,
  live = false,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  live?: boolean;
  format(value: number): string;
  onChange(value: number): void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  return (
    <>
      <Slider.Root
        className="min-w-0 flex-1"
        value={shown}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => (live ? next !== value && onChange(next) : setDraft(next))}
        onValueCommitted={(next) => {
          setDraft(null);
          if (!live && next !== value) onChange(next);
        }}
      >
        <Slider.Control className="flex h-7 cursor-pointer touch-none items-center">
          <Slider.Track className="h-1 w-full rounded-full bg-ink ring-1 ring-line ring-inset">
            <Slider.Indicator className="rounded-full bg-accent" />
            <Slider.Thumb
              aria-label={label}
              className="size-3.5 rounded-full bg-text shadow-[0_0_0_1px_var(--panel),0_1px_3px_rgb(0_0_0/0.35)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="tnum w-12 shrink-0 text-right text-[calc(12.5px*var(--font-scale))] text-text">{format(shown)}</span>
    </>
  );
}

function PreferencesBody() {
  const t = useT().preferences;
  const preferences = useApp((s) => s.preferences);
  const decimal = (value: number) => value.toLocaleString(preferences.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isDefault = (Object.keys(defaultPreferences) as (keyof PreferenceValues)[]).every((key) => preferences[key] === defaultPreferences[key]);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title={t.appearance}>
          <span className="self-start pt-1.5 text-[calc(12.5px*var(--font-scale))] text-dim">{t.theme}</span>
          <ThemePicker value={preferences.theme} />
          <Row label={t.accent}>
            <AccentPicker value={preferences.accentColor} />
          </Row>
          <Row label={t.uiScale}>
            <div className="min-w-0 flex-1">
              <Segmented
                label={t.uiScale}
                value={preferences.uiScale}
                options={uiScales.map((scale) => ({ value: scale, title: String(Math.round(scale * 100)), ariaLabel: percent(scale) }))}
                onChange={(uiScale) => set({ uiScale })}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-[calc(12.5px*var(--font-scale))] text-text tnum">{percent(preferences.uiScale)}</span>
          </Row>
          <Row label={t.fontScale}>
            <PreferenceSlider label={t.fontScale} value={preferences.fontScale} min={0.85} max={1.3} step={0.05} format={percent} onChange={(fontScale) => set({ fontScale })} />
          </Row>
        </Section>

        <Section title={t.language}>
          <Row label={t.languageLabel}>
            <div className="min-w-0 flex-1">
              <Segmented
                label={t.language}
                value={preferences.language}
                // The names of the languages stay in their own language.
                options={[
                  { value: 'de', title: 'Deutsch' },
                  { value: 'en', title: 'English' },
                ]}
                onChange={(language) => set({ language })}
              />
            </div>
          </Row>
        </Section>

        <Section title={t.viewport}>
          <Row label={t.showGrid}>
            <Switch checked={preferences.showGrid} label={t.showGrid} onChange={(showGrid) => set({ showGrid })} />
          </Row>
          <Row label={t.showAxes}>
            <Switch checked={preferences.showAxes} label={t.showAxes} onChange={(showAxes) => set({ showAxes })} />
          </Row>
          <Row label={t.fieldOfView}>
            <PreferenceSlider live label={t.fieldOfView} value={preferences.fieldOfView} min={20} max={100} step={1} format={(v) => `${v}°`} onChange={(fieldOfView) => set({ fieldOfView })} />
          </Row>
          <Row label={t.orbitSpeed}>
            <PreferenceSlider live label={t.orbitSpeed} value={preferences.orbitSpeed} min={0.25} max={3} step={0.05} format={(v) => `${decimal(v)}×`} onChange={(orbitSpeed) => set({ orbitSpeed })} />
          </Row>
          <Row label={t.zoomSpeed}>
            <PreferenceSlider live label={t.zoomSpeed} value={preferences.zoomSpeed} min={0.25} max={3} step={0.05} format={(v) => `${decimal(v)}×`} onChange={(zoomSpeed) => set({ zoomSpeed })} />
          </Row>
          <Row label={t.invertZoom}>
            <Switch checked={preferences.invertZoom} label={t.invertZoom} onChange={(invertZoom) => set({ invertZoom })} />
          </Row>
        </Section>

        <Section title={t.editing}>
          <Row label={t.undoSteps}>
            <span className="text-[calc(12px*var(--font-scale))] text-faint">{t.undoStepsHint}</span>
            <div className="w-32 shrink-0">
              <ScrubField
                wide
                integer
                label={t.undoStepsField}
                ariaLabel={t.undoSteps}
                color="var(--faint)"
                value={preferences.undoSteps}
                step={1}
                min={10}
                max={1000}
                onCommit={(undoSteps) => set({ undoSteps })}
              />
            </div>
          </Row>
        </Section>
      </div>

      <footer className="flex shrink-0 items-center border-t border-line px-3 py-2.5">
        <button
          disabled={isDefault}
          className="flex h-8 items-center gap-2 rounded-md px-2.5 text-[calc(13px*var(--font-scale))] text-dim hover:bg-raised hover:text-text disabled:text-faint/60 disabled:hover:bg-transparent"
          onClick={() => void dispatch('preferences.reset')}
        >
          <RotateCcw size={14} strokeWidth={1.75} />
          {t.reset}
        </button>
      </footer>
    </>
  );
}

/** The preferences dialog. Every control writes its preference right away; there is nothing to confirm. */
export function Preferences() {
  const t = useT();
  const open = useUi((s) => s.preferencesOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(preferencesOpen) => useUi.setState({ preferencesOpen })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-scrim" />
        <Dialog.Popup className="anim-pop fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(33rem,calc(100%-2rem))] flex-col overflow-hidden rounded-xl border border-line-strong bg-overlay shadow-pop outline-none">
          <header className="flex shrink-0 items-center border-b border-line py-2.5 pr-2.5 pl-5">
            <Dialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.preferences.title}</Dialog.Title>
            <Dialog.Close aria-label={t.common.close} className="ml-auto flex size-7 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text">
              <X size={15} strokeWidth={1.75} />
            </Dialog.Close>
          </header>
          <PreferencesBody />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
