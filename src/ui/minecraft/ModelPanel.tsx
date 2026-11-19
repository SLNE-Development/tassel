import { ImagePlus, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useRef } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { validateJavaModel, type JavaIssue } from '../../core/minecraft/validate';
import { javaVersions } from '../../core/minecraft/versions';
import { guiLights, type JavaModelSettings, type Texture } from '../../core/types';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { PickMenu, Segmented, Switch } from '../controls';
import { ScrubField } from '../ScrubField';
import { addTextureFromFile, textureAccept, useThumbnail } from '../textureFiles';
import { notifyError } from '../toast';
import { ParentSection } from '../modelImport/ParentSection';
import { FieldRow, SectionTitle, smallButton, TextField } from './fields';

const setSettings = (changes: Record<string, unknown>) => void dispatch('minecraft.set_settings', changes);

/** Findings of the model check; a click selects the element or texture they are about. */
function Issues({ issues }: { issues: readonly JavaIssue[] }) {
  const state = useApp((s) => selectDocState(s));
  const t = useT().mc;
  if (issues.length === 0) return <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.validOk}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {issues.map((issue, i) => {
        const subject = issue.objectId ? state.objects[issue.objectId]?.name : issue.textureId ? state.textures[issue.textureId]?.name : undefined;
        return (
          <li key={i}>
            <button
              className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left text-[calc(12px*var(--font-scale))] leading-snug hover:bg-raised"
              onClick={() => issue.objectId && state.objects[issue.objectId] && void dispatch('scene.select', { ids: [issue.objectId], mode: 'replace' })}
            >
              <TriangleAlert size={13} strokeWidth={2} className={`mt-0.5 shrink-0 ${issue.severity === 'error' ? 'text-danger' : 'text-accent'}`} />
              <span className="min-w-0 text-dim">
                {subject && <span className="text-text">{subject}: </span>}
                {t.issues[issue.code]}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TextureSize({ java }: { java: JavaModelSettings }) {
  const t = useT().mc.model;
  return (
    <div className="grid grid-cols-2 gap-1">
      {(['W', 'H'] as const).map((label, i) => (
        <ScrubField
          key={label}
          integer
          label={label}
          ariaLabel={`${t.textureSize} ${label}`}
          color="var(--faint)"
          value={java.textureSize[i]}
          step={1}
          min={1}
          max={4096}
          onCommit={(value) => setSettings({ textureSize: i === 0 ? [value, java.textureSize[1]] : [java.textureSize[0], value] })}
        />
      ))}
    </div>
  );
}

/** Model settings (the model JSON's root keys) and the result of the model check. */
export function ModelSettings() {
  const java = useApp((s) => selectDocState(s).java);
  const textures = useApp((s) => selectDocState(s).textures);
  const state = useApp((s) => selectDocState(s));
  const issues = useMemo(() => validateJavaModel(state), [state]);
  const t = useT().mc;
  if (!java) return null;
  const textureOptions = [{ value: '', title: t.model.noParticle }, ...Object.values(textures).map((tex) => ({ value: tex.id, title: tex.name }))];
  return (
    <div className="flex flex-col gap-2.5">
      <FieldRow title={t.model.fileName}>
        <TextField label={t.model.fileName} value={java.fileName} mono onCommit={(fileName) => fileName && setSettings({ fileName })} />
      </FieldRow>
      <FieldRow title={t.model.parent}>
        <TextField label={t.model.parent} value={java.parent} mono placeholder={t.model.parentHint} onCommit={(parent) => setSettings({ parent })} />
      </FieldRow>
      <FieldRow title={t.model.ambientOcclusion}>
        <Switch label={t.model.ambientOcclusion} checked={java.ambientOcclusion} onChange={(ambientOcclusion) => setSettings({ ambientOcclusion })} />
      </FieldRow>
      <FieldRow title={t.model.guiLight}>
        <Segmented
          label={t.model.guiLight}
          value={java.guiLight ?? 'none'}
          options={[{ value: 'none', title: t.model.guiNone }, ...guiLights.map((l) => ({ value: l, title: t.model.gui[l] }))]}
          onChange={(value) => setSettings({ guiLight: value === 'none' ? null : value })}
        />
      </FieldRow>
      <FieldRow title={t.model.textureSize}>
        <TextureSize java={java} />
      </FieldRow>
      <FieldRow title={t.model.particle}>
        <PickMenu
          label={t.model.particle}
          value={java.particle ?? ''}
          placeholder={t.model.noParticle}
          options={textureOptions}
          onChange={(particle) => setSettings({ particle: particle === '' ? null : particle })}
        />
      </FieldRow>
      <FieldRow title={t.model.credit}>
        <TextField label={t.model.credit} value={java.credit} onCommit={(credit) => setSettings({ credit })} />
      </FieldRow>
      <FieldRow title={t.model.version}>
        <PickMenu
          label={t.model.version}
          value={java.version}
          placeholder={java.version}
          options={javaVersions.map((v) => ({ value: v.id, title: v.label }))}
          onChange={(version) => setSettings({ version })}
        />
      </FieldRow>
      <ParentSection />
      <SectionTitle>{t.model.check}</SectionTitle>
      <Issues issues={issues} />
    </div>
  );
}

function TextureRow({ texture }: { texture: Texture }) {
  const thumbnail = useThumbnail(texture);
  const t = useT().mc.textures;
  const ref = texture.java ?? { namespace: 'minecraft', folder: 'block', key: '' };
  const set = (changes: Record<string, unknown>) => void dispatch('minecraft.set_texture', { texture: texture.id, ...changes });
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line p-2">
      <div className="flex items-center gap-2">
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-ink ring-1 ring-line ring-inset">
          {thumbnail && <img src={thumbnail} alt="" className="size-full object-contain" style={{ imageRendering: 'pixelated' }} />}
        </span>
        <div className="min-w-0 flex-1">
          <TextField label={t.name} value={texture.name} mono onCommit={(name) => name && set({ name })} />
          <div className="tnum mt-0.5 text-[calc(11.5px*var(--font-scale))] text-faint">
            {texture.width} × {texture.height}
          </div>
        </div>
        <button
          aria-label={t.remove}
          title={t.remove}
          className="flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-danger"
          onClick={() => void dispatch('texture.remove', { id: texture.id })}
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.6fr)] gap-1">
        <TextField label={t.namespace} value={ref.namespace} mono onCommit={(namespace) => namespace && set({ namespace })} />
        <TextField label={t.folder} value={ref.folder} mono onCommit={(folder) => set({ folder })} />
        <TextField label={t.key} value={ref.key} mono onCommit={(key) => key && set({ key })} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.6fr)] gap-1 text-[calc(11px*var(--font-scale))] text-faint">
        <span>{t.namespace}</span>
        <span>{t.folder}</span>
        <span>{t.key}</span>
      </div>
      <button className={smallButton} onClick={() => void dispatch('cuboid.set_face', { texture: texture.id })}>
        {t.useOnSelection}
      </button>
    </li>
  );
}

/** The textures of the model with their resource locations. */
export function TexturesPanel() {
  const textures = useApp((s) => selectDocState(s).textures);
  const t = useT().mc.textures;
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => Object.values(textures), [textures]);
  const add = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      try {
        await addTextureFromFile(file);
      } catch (error) {
        notifyError(error);
      }
    }
    if (input.current) input.current.value = '';
  };
  return (
    <div className="flex flex-col gap-2">
      <input ref={input} type="file" multiple hidden accept={textureAccept} onChange={(e) => void add(e.currentTarget.files)} />
      <button className={smallButton} onClick={() => input.current?.click()}>
        <ImagePlus size={14} strokeWidth={1.75} />
        {t.add}
      </button>
      {list.length === 0 && <p className="text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{t.empty}</p>}
      <ul className="flex flex-col gap-2">
        {list.map((texture) => (
          <TextureRow key={texture.id} texture={texture} />
        ))}
      </ul>
    </div>
  );
}
