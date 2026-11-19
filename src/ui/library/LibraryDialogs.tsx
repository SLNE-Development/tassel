import { useEffect, useState } from 'react';
import { execute } from '../../app/store';
import { tryTextureLocation, validFolder, validNamespace } from '../../core/textureLibrary';
import { useT } from '../../i18n';
import { inputClass, labelClass, primaryButton, ProjectDialog, quietButton } from '../projects/dialogParts';
import { notifyError, notifySuccess } from '../toast';
import { refreshLibrary, useLibraryUi } from './libraryUi';

/** The file as a PNG (base64); JPEG and WebP are converted, as resource packs only use PNG. */
async function pngBase64(file: File): Promise<string> {
  let blob: Blob = file;
  if (file.type !== 'image/png' && !/\.png$/i.test(file.name)) {
    const bitmap = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    blob = await canvas.convertToBlob({ type: 'image/png' });
  }
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A file name as a texture name: lower case, spaces as underscores, only characters Minecraft accepts. */
export function textureFileName(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_.-]/g, '');
}

function ImportDialog() {
  const t = useT();
  const files = useLibraryUi((s) => s.importing);
  const filterNamespace = useLibraryUi((s) => s.namespace);
  const filterFolder = useLibraryUi((s) => s.folder);
  const [namespace, setNamespace] = useState('');
  const [folder, setFolder] = useState('');
  const close = () => useLibraryUi.setState({ importing: null });

  useEffect(() => {
    if (!files) return;
    void (execute('library.get_config', {}) as Promise<{ config: { textures: { defaultNamespace: string | null; defaultFolder: string } } }>).then(
      ({ config }) => {
        setNamespace(filterNamespace && filterNamespace !== 'minecraft' ? filterNamespace : (config.textures.defaultNamespace ?? 'minecraft'));
        setFolder(filterFolder ?? config.textures.defaultFolder);
      },
      () => {
        setNamespace(filterNamespace ?? 'minecraft');
        setFolder(filterFolder ?? 'block');
      },
    );
  }, [files, filterNamespace, filterFolder]);

  const okNamespace = validNamespace(namespace);
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');
  const okFolder = validFolder(cleanFolder);
  const submit = async () => {
    if (!files || !okNamespace || !okFolder) return;
    close();
    let imported = 0;
    for (const file of files) {
      try {
        const data = await pngBase64(file);
        await execute('library.import', { name: textureFileName(file.name) || 'texture', data, namespace, folder: cleanFolder });
        imported++;
      } catch (error) {
        notifyError(error);
      }
    }
    if (imported > 0) notifySuccess(t.library.imported(imported), `${namespace}:${cleanFolder}`);
    await refreshLibrary(false);
  };

  return (
    <ProjectDialog
      open={!!files}
      onClose={close}
      title={t.library.importTitle(files?.length ?? 0)}
      footer={
        <>
          <button className={`${quietButton} mr-auto`} onClick={close}>
            {t.dialogs.cancel}
          </button>
          <button className={primaryButton} disabled={!okNamespace || !okFolder} onClick={() => void submit()}>
            {t.library.import}
          </button>
        </>
      }
    >
      <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto font-mono text-[calc(12px*var(--font-scale))] text-dim">
        {files?.map((file) => (
          <li key={file.name} className="truncate">
            {namespace}:{cleanFolder ? `${cleanFolder}/` : ''}
            {textureFileName(file.name)}
          </li>
        ))}
      </ul>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t.library.namespace}</span>
        <input className={`${inputClass} font-mono`} value={namespace} spellCheck={false} onChange={(e) => setNamespace(e.currentTarget.value.trim().toLowerCase())} />
        {!okNamespace && <span className="text-[calc(12px*var(--font-scale))] text-danger">{t.library.badNamespace}</span>}
      </label>
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t.library.folder}</span>
        <input className={`${inputClass} font-mono`} value={folder} spellCheck={false} onChange={(e) => setFolder(e.currentTarget.value.toLowerCase())} />
        {!okFolder && <span className="text-[calc(12px*var(--font-scale))] text-danger">{t.library.badFolder}</span>}
      </label>
    </ProjectDialog>
  );
}

function MoveDialog() {
  const t = useT();
  const entry = useLibraryUi((s) => s.moving);
  const [value, setValue] = useState('');
  const [rewrite, setRewrite] = useState(true);
  const close = () => useLibraryUi.setState({ moving: null });
  useEffect(() => {
    if (entry) setValue(entry.location);
  }, [entry]);
  const target = tryTextureLocation(value);
  const submit = async () => {
    if (!entry || !target) return;
    close();
    try {
      const result = (await execute('library.move', { from: entry.location, to: value, rewrite })) as { relinkedTextures: number; rewrittenFiles: string[] };
      notifySuccess(t.library.moved, t.library.movedDetails(result.relinkedTextures, result.rewrittenFiles.length));
    } catch (error) {
      notifyError(error);
    }
  };
  return (
    <ProjectDialog
      open={!!entry}
      onClose={close}
      title={t.library.move}
      footer={
        <>
          <button className={`${quietButton} mr-auto`} onClick={close}>
            {t.dialogs.cancel}
          </button>
          <button className={primaryButton} disabled={!target || value === entry?.location} onClick={() => void submit()}>
            {t.library.moveButton}
          </button>
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className={labelClass}>{t.library.location}</span>
        <input
          autoFocus
          className={`${inputClass} font-mono`}
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {!target && <span className="text-[calc(12px*var(--font-scale))] text-danger">{t.library.badLocation}</span>}
      </label>
      <label className="flex items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-dim">
        <input type="checkbox" checked={rewrite} onChange={(e) => setRewrite(e.currentTarget.checked)} />
        {t.library.rewrite}
      </label>
    </ProjectDialog>
  );
}

export function LibraryDialogs() {
  return (
    <>
      <ImportDialog />
      <MoveDialog />
    </>
  );
}
