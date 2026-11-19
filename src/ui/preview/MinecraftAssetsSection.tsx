import { FileArchive, FolderOpen, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../../app/store';
import type { MinecraftInstall } from '../../core/minecraftAssets';
import { useT } from '../../i18n';
import { detectMinecraftInstalls } from '../../mcassets';
import { dispatch } from '../actions';
import { PickMenu } from '../controls';
import { chooseAssets, useMinecraftAssetsStatus } from './previewActions';

const text = 'text-[calc(12.5px*var(--font-scale))]';
const button = `flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-ink px-2 ${text} text-dim ring-1 ring-line ring-inset hover:text-text hover:ring-line-strong`;

/** Preferences section: where vanilla Minecraft assets come from (an installed client .jar or a resource pack folder). */
export function MinecraftAssetsSection() {
  const t = useT().preview.assets;
  const path = useApp((s) => s.preferences.minecraftAssets);
  const status = useMinecraftAssetsStatus();
  const [installs, setInstalls] = useState<MinecraftInstall[] | null>(null);

  useEffect(() => {
    let live = true;
    detectMinecraftInstalls().then(
      (found) => live && setInstalls(found),
      () => live && setInstalls([]),
    );
    return () => {
      live = false;
    };
  }, []);

  const state =
    status.state === 'ready'
      ? t.ready(status.info?.version ?? '')
      : status.state === 'loading'
        ? t.loading
        : status.state === 'error'
          ? `${t.error}: ${status.error ?? ''}`
          : status.state === 'unavailable'
            ? t.unavailable
            : t.none;
  const installed = installs?.find((install) => install.path === path) ?? null;

  return (
    <section className="border-t border-line px-5 pt-3.5 pb-4">
      <h3 className="mb-1 font-display text-[calc(13px*var(--font-scale))] font-semibold text-text">{t.title}</h3>
      <p className={`mb-2.5 ${text} text-faint`}>{t.hint}</p>
      <div className="grid grid-cols-[minmax(0,10.5rem)_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5">
        <span className={`${text} text-dim`}>{t.installed}</span>
        <PickMenu
          label={t.installed}
          value={installed?.path ?? null}
          options={(installs ?? []).map((install) => ({ value: install.path, title: install.version }))}
          placeholder={installs && installs.length === 0 ? t.noInstalls : t.pickInstall}
          onChange={(chosen) => void dispatch('assets.set_minecraft', { path: chosen })}
        />
        <span className={`self-start pt-1.5 ${text} text-dim`}>{t.source}</span>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className={`truncate ${text} ${path ? 'text-text' : 'text-faint'}`} title={path || undefined}>
            {path || t.none}
          </span>
          <span className={`${text} ${status.state === 'error' ? 'text-[var(--danger,#d9534f)]' : 'text-faint'}`}>{state}</span>
          <div className="flex flex-wrap gap-1.5">
            <button className={button} onClick={() => void chooseAssets('jar')}>
              <FileArchive size={13} />
              {t.chooseJar}
            </button>
            <button className={button} onClick={() => void chooseAssets('folder')}>
              <FolderOpen size={13} />
              {t.chooseFolder}
            </button>
            {path && (
              <button className={button} onClick={() => void dispatch('assets.set_minecraft', { path: '' })}>
                <X size={13} />
                {t.clear}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
