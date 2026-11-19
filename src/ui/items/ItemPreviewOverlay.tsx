// Floats over the viewport of item definition documents: which models are shown and why others are not.
import { Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { selectActiveDoc, useApp } from '../../app/store';
import { shortId } from '../../core/minecraft/items/registry';
import { useT } from '../../i18n';
import { iconButton } from './fieldEditors';
import { reloadPreview, selectNode, useItemUi } from './itemStore';
import { getMinecraftAssets } from '../../mcassets';

export function ItemPreviewOverlay() {
  const doc = useApp(selectActiveDoc);
  const t = useT().items;
  const status = useItemUi((s) => s.preview[doc.id]);
  if (!doc.state.item) return null;
  const noAssets = !getMinecraftAssets();
  return (
    <div className="pointer-events-none absolute top-2 left-2 flex max-w-[min(26rem,calc(100%-1rem))] flex-col gap-1">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-lg border border-line bg-panel/90 py-1 pr-1 pl-2.5 text-[calc(12px*var(--font-scale))] backdrop-blur-sm">
        {status?.state === 'loading' ? <LoaderCircle size={13} className="shrink-0 animate-spin text-faint" /> : <span className="size-2 shrink-0 rounded-full bg-accent" />}
        <span className="min-w-0 truncate text-dim">
          {t.preview.shows}{' '}
          <span className="font-mono text-text">{status && status.shown.length > 0 ? status.shown.map(shortId).join(' + ') : t.preview.nothing}</span>
        </span>
        <button type="button" className={`${iconButton} ml-auto`} title={t.preview.reload} aria-label={t.preview.reload} onClick={reloadPreview}>
          <RefreshCw size={12} />
        </button>
      </div>
      {noAssets && (
        <p className="pointer-events-auto flex items-start gap-1.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-[calc(12px*var(--font-scale))] leading-snug text-dim backdrop-blur-sm">
          <Info size={13} className="mt-0.5 shrink-0 text-faint" />
          {t.preview.noAssets}
        </p>
      )}
      {status?.notes.map((note) => (
        <button
          key={note.path + note.problem}
          type="button"
          className="pointer-events-auto flex items-start gap-1.5 rounded-lg border border-line bg-panel/90 px-2.5 py-1.5 text-left text-[calc(12px*var(--font-scale))] leading-snug text-dim backdrop-blur-sm hover:border-line-strong"
          title={note.detail}
          onClick={() => selectNode(doc.id, note.path)}
        >
          <Info size={13} className="mt-0.5 shrink-0 text-faint" />
          <span className="min-w-0">
            <span className="font-mono text-text">{note.model ? shortId(note.model) : t.noModel}</span> {t.preview.problems[note.problem]}
          </span>
        </button>
      ))}
    </div>
  );
}
