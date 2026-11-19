import { isTauri } from '@tauri-apps/api/core';
import { BookImage, Link2, LocateFixed, Save, TriangleAlert, Unlink } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { execute } from '../../app/store';
import { linkLocation, textureLink } from '../../core/textureLibrary';
import type { Texture } from '../../core/types';
import { useT } from '../../i18n';
import { Tip } from '../Tip';
import { notifyError, notifySuccess } from '../toast';
import { droppedTexture, isTextureDrag, startRelink, useLinkStatus } from './libraryUi';

const iconButton =
  'flex size-6 shrink-0 items-center justify-center rounded text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';

function Action({ label, icon, onClick }: { label: string; icon: ReactNode; onClick(): unknown }) {
  return (
    <Tip label={label}>
      <button aria-label={label} className={iconButton} onClick={() => void Promise.resolve(onClick()).catch(notifyError)}>
        {icon}
      </button>
    </Tip>
  );
}

/** A small link icon for texture thumbnails: linked, missing or nothing for embedded textures. */
export function LinkBadge({ texture }: { texture: Texture }) {
  const t = useT().library;
  const { status } = useLinkStatus(texture);
  if (status === 'embedded') return null;
  const missing = status === 'missing';
  const label = missing ? t.missing(linkLocation(texture.link!)) : t.linkedTo(linkLocation(texture.link!));
  return (
    <span title={label} aria-label={label} className={`absolute right-0 bottom-0 rounded-tl-[4px] bg-panel/90 p-px ${missing ? 'text-danger' : 'text-accent'}`}>
      {missing ? <TriangleAlert size={10} strokeWidth={2.25} /> : <Link2 size={10} strokeWidth={2.25} />}
    </span>
  );
}

/**
 * How a document texture stands with the texture library, with the actions that fit: linked (unlink,
 * relink, save to the library), missing (locate) or embedded (link, add to the library).
 */
export function TextureLinkBar({ texture }: { texture: Texture }) {
  const t = useT().library;
  const { status, entry } = useLinkStatus(texture);
  if (!isTauri()) return null;
  const location = texture.link ? linkLocation(texture.link) : null;
  const unlink = () => execute('texture.unlink', { id: texture.id });
  const save = async () => {
    const result = (await execute('library.save_texture', { id: texture.id })) as { file: string };
    notifySuccess(t.savedToLibrary, result.file);
  };
  const addToLibrary = async () => {
    const link = textureLink(texture);
    const params = link
      ? { name: link.path.split('/').pop()!, namespace: link.namespace, folder: link.path.split('/').slice(0, -1).join('/') }
      : { name: texture.name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_.-]/g, '') || 'texture' };
    if (texture.mimeType !== 'image/png') throw new Error(t.onlyPng);
    const result = (await execute('library.import', { ...params, data: texture.data, link: texture.id })) as { entry: { location: string } };
    notifySuccess(t.addedToLibrary, result.entry.location);
  };
  const tone = status === 'missing' ? 'text-danger' : status === 'embedded' ? 'text-faint' : 'text-accent';
  const label =
    status === 'missing' ? t.missingShort : status === 'embedded' ? t.embedded : status === 'vanilla' ? t.vanillaLinked : t.linked;
  return (
    <div className="flex min-w-0 items-center gap-1 text-[calc(11.5px*var(--font-scale))]">
      <span className={`flex shrink-0 items-center gap-1 ${tone}`}>
        {status === 'missing' ? <TriangleAlert size={12} strokeWidth={2} /> : status === 'embedded' ? <BookImage size={12} strokeWidth={1.75} /> : <Link2 size={12} strokeWidth={2} />}
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-faint" title={entry ? `${location}\n${entry.file}` : (location ?? '')}>
        {location}
      </span>
      {status === 'missing' && <Action label={t.locate} icon={<LocateFixed size={13} />} onClick={() => startRelink(texture)} />}
      {status === 'embedded' && (
        <>
          <Action label={t.linkToLibrary} icon={<Link2 size={13} />} onClick={() => startRelink(texture)} />
          <Action label={t.addToLibrary} icon={<Save size={13} />} onClick={addToLibrary} />
        </>
      )}
      {(status === 'linked' || status === 'vanilla') && (
        <>
          {status === 'linked' && <Action label={t.saveToLibrary} icon={<Save size={13} />} onClick={save} />}
          <Action label={t.relink} icon={<LocateFixed size={13} />} onClick={() => startRelink(texture)} />
        </>
      )}
      {status !== 'embedded' && <Action label={t.unlink} icon={<Unlink size={13} />} onClick={unlink} />}
    </div>
  );
}

/** Drop target props for library textures: `onTexture` gets the dropped location and source. */
export function useTextureDrop(onTexture: (dragged: { location: string; source: string }) => unknown) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!isTextureDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        const dragged = droppedTexture(e);
        setOver(false);
        if (!dragged) return;
        e.preventDefault();
        e.stopPropagation();
        void Promise.resolve(onTexture(dragged)).catch(notifyError);
      },
    },
  };
}
