import { ContextMenu } from '@base-ui/react/context-menu';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Box,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Film,
  Folder,
  FolderPlus,
  ImagePlus,
  Link2,
  PanelLeftClose,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { execute } from '../../app/store';
import { filterEntries, libraryTree, type LibraryEntry } from '../../core/textureLibrary';
import { useT } from '../../i18n';
import { trashLibraryTexture } from '../../texlib';
import { itemClass } from '../menu';
import { Tip } from '../Tip';
import { notifyError } from '../toast';
import { LibraryDialogs } from './LibraryDialogs';
import {
  refreshLibrary,
  setLibraryPanelOpen,
  startTextureDrag,
  applyLibraryEntry,
  useLibraryScans,
  useLibraryThumbnail,
  useLibraryUi,
} from './libraryUi';

const iconButton =
  'flex size-6.5 shrink-0 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const fieldClass =
  'h-7 w-full min-w-0 rounded-md bg-ink px-2 text-[calc(12.5px*var(--font-scale))] text-text ring-1 ring-line outline-none ring-inset hover:ring-line-strong focus:ring-accent';
/** Tiles shown before "show more", so the vanilla set (thousands) does not build a huge grid at once. */
const PAGE = 240;

function IconButton({ label, icon: Icon, onClick, spin }: { label: string; icon: LucideIcon; onClick(): unknown; spin?: boolean }) {
  return (
    <Tip label={label}>
      <button aria-label={label} className={iconButton} onClick={() => void onClick()}>
        <Icon size={14} strokeWidth={1.75} className={spin ? 'animate-spin motion-reduce:animate-none' : ''} />
      </button>
    </Tip>
  );
}

function Tile({ entry, shadowed }: { entry: LibraryEntry; shadowed: boolean }) {
  const t = useT().library;
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(([item]) => item.isIntersecting && setVisible(true), { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const url = useLibraryThumbnail(entry, visible);
  const name = entry.path.split('/').pop()!;
  const size = entry.width > 0 ? `${entry.width} × ${entry.height}` : '';
  const frames = entry.animation && entry.animation.frames > 0 ? t.frames(entry.animation.frames, entry.animation.frametime) : entry.animation ? t.animated : '';
  const details = [entry.location, size, frames, shadowed ? t.shadowed : ''].filter(Boolean).join('\n');
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        render={
          <button
            ref={ref}
            title={details}
            draggable
            onDragStart={(e) => startTextureDrag(e, entry)}
            onDoubleClick={() => void applyLibraryEntry(entry)}
            onKeyDown={(e) => e.key === 'Enter' && void applyLibraryEntry(entry)}
            className={`group flex min-w-0 flex-col items-center gap-1 rounded-md p-1 text-left outline-none hover:bg-raised focus-visible:ring-1 focus-visible:ring-accent ${shadowed ? 'opacity-55' : ''}`}
          />
        }
      >
        <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded bg-ink ring-1 ring-line ring-inset">
          {url && <img src={url} alt="" draggable={false} className="size-full object-contain" style={{ imageRendering: 'pixelated', objectPosition: 'top' }} />}
          {entry.animation && <Film size={11} strokeWidth={2} className="absolute top-0.5 right-0.5 text-accent drop-shadow" aria-label={t.animated} />}
          {entry.sourceKind === 'vanilla' && <Box size={11} strokeWidth={2} className="absolute bottom-0.5 left-0.5 text-faint drop-shadow" aria-label={t.vanilla} />}
        </span>
        <span className="w-full truncate text-center text-[calc(11px*var(--font-scale))] text-dim group-hover:text-text">{name}</span>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className="anim-pop min-w-48 rounded-lg border border-line-strong bg-overlay p-1 shadow-pop outline-none">
            <TileMenu entry={entry} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function TileMenu({ entry }: { entry: LibraryEntry }) {
  const t = useT().library;
  const relink = useLibraryUi((s) => s.relink);
  const item = (icon: LucideIcon, title: string, run: () => unknown, danger = false) => {
    const Icon = icon;
    return (
      <ContextMenu.Item className={`${itemClass} ${danger ? 'text-danger' : ''}`} onClick={() => void Promise.resolve(run()).catch(notifyError)}>
        <Icon size={14} strokeWidth={1.75} />
        <span>{title}</span>
      </ContextMenu.Item>
    );
  };
  return (
    <>
      {item(relink ? Link2 : Plus, relink ? t.relinkTo(relink.name) : t.addToDocument, () => applyLibraryEntry(entry))}
      {item(Copy, t.copyLocation, () => navigator.clipboard.writeText(entry.location))}
      {!entry.readOnly && (
        <>
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-line-strong" />
          {item(PencilLine, t.move, () => useLibraryUi.setState({ moving: entry }))}
          {item(ExternalLink, t.reveal, () => execute('library.reveal', { location: entry.location, source: entry.source }))}
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-line-strong" />
          {item(Trash2, t.trash, () => trashLibraryTexture(entry), true)}
        </>
      )}
    </>
  );
}

function Tree({ tree }: { tree: ReturnType<typeof libraryTree> }) {
  const namespace = useLibraryUi((s) => s.namespace);
  const folder = useLibraryUi((s) => s.folder);
  const t = useT().library;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const row = (key: string, label: ReactNode, active: boolean, depth: number, onClick: () => void, toggle?: ReactNode) => (
    <div
      key={key}
      role="treeitem"
      aria-selected={active}
      className={`flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md pr-1.5 text-[calc(12px*var(--font-scale))] ${active ? 'bg-accent/12 text-text' : 'text-dim hover:bg-raised hover:text-text'}`}
      style={{ paddingLeft: 4 + depth * 12 }}
      onClick={onClick}
    >
      {toggle ?? <span className="w-3.5 shrink-0" />}
      {label}
    </div>
  );
  return (
    <div role="tree" aria-label={t.namespaces} className="flex max-h-44 shrink-0 flex-col gap-px overflow-y-auto border-b border-line px-1.5 pb-1.5">
      {row('*', <span className="truncate">{t.allNamespaces}</span>, namespace === null, 0, () => useLibraryUi.setState({ namespace: null, folder: null }))}
      {tree.map((ns) => {
        const open = !collapsed.has(ns.namespace);
        const toggle = (
          <button
            aria-label={open ? t.collapse : t.expand}
            className="flex w-3.5 shrink-0 justify-center"
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(collapsed);
              if (open) next.add(ns.namespace);
              else next.delete(ns.namespace);
              setCollapsed(next);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        );
        return [
          row(
            ns.namespace,
            <>
              <span className="min-w-0 flex-1 truncate font-mono">{ns.namespace}</span>
              <span className="tnum text-faint">{ns.count}</span>
            </>,
            namespace === ns.namespace && folder === null,
            0,
            () => useLibraryUi.setState({ namespace: ns.namespace, folder: null }),
            ns.folders.length > 0 ? toggle : undefined,
          ),
          ...(open
            ? ns.folders.map((f) =>
                row(
                  `${ns.namespace}:${f}`,
                  <>
                    <Folder size={12} strokeWidth={1.75} className="shrink-0 opacity-70" />
                    <span className="min-w-0 truncate font-mono">{f.split('/').pop()}</span>
                  </>,
                  namespace === ns.namespace && folder === f,
                  1 + f.split('/').length - 1,
                  () => useLibraryUi.setState({ namespace: ns.namespace, folder: f }),
                ),
              )
            : []),
        ];
      })}
    </div>
  );
}

/** Default namespace and folder of the project (tessel.project.json), shared with the team through git. */
function ProjectDefaults() {
  const t = useT().library;
  const [config, setConfig] = useState<{ project: string | null; namespace: string; folder: string } | null>(null);
  const scans = useLibraryScans();
  useEffect(() => {
    let live = true;
    void (execute('library.get_config', {}) as Promise<{ project: string | null; config: { textures: { defaultNamespace: string | null; defaultFolder: string } } }>).then(
      (result) => live && setConfig({ project: result.project, namespace: result.config.textures.defaultNamespace ?? '', folder: result.config.textures.defaultFolder }),
      () => live && setConfig(null),
    );
    return () => {
      live = false;
    };
  }, [scans]);
  if (!config?.project) return null;
  const save = (changes: { defaultNamespace?: string | null; defaultFolder?: string }) =>
    void (execute('library.set_config', changes) as Promise<unknown>).then(() => refreshLibrary(false), notifyError);
  return (
    <div className="grid shrink-0 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-1 px-1.5 pb-1.5" title={t.defaultsHint}>
      <input
        key={`ns-${config.namespace}`}
        aria-label={t.defaultNamespace}
        placeholder={t.defaultNamespace}
        defaultValue={config.namespace}
        spellCheck={false}
        className={`${fieldClass} font-mono`}
        onBlur={(e) => e.currentTarget.value.trim() !== config.namespace && save({ defaultNamespace: e.currentTarget.value.trim() || null })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <input
        key={`folder-${config.folder}`}
        aria-label={t.defaultFolder}
        placeholder={t.defaultFolder}
        defaultValue={config.folder}
        spellCheck={false}
        className={`${fieldClass} font-mono`}
        onBlur={(e) => e.currentTarget.value.trim() !== config.folder && save({ defaultFolder: e.currentTarget.value.trim() })}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </div>
  );
}

async function addFolder(title: string): Promise<void> {
  const path = await open({ directory: true, multiple: false, title });
  if (!path) return;
  try {
    await execute('library.add_folder', { path });
  } catch (error) {
    notifyError(error);
  }
}

/** The Textures library: resource-pack textures of the project, library folders and vanilla. */
export function TextureLibraryPanel() {
  const t = useT().library;
  const scans = useLibraryScans();
  const source = useLibraryUi((s) => s.source);
  const namespace = useLibraryUi((s) => s.namespace);
  const folder = useLibraryUi((s) => s.folder);
  const search = useLibraryUi((s) => s.search);
  const relink = useLibraryUi((s) => s.relink);
  const busy = useLibraryUi((s) => s.busy);
  const [limit, setLimit] = useState(PAGE);
  const [dropping, setDropping] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refreshLibrary(false);
    // Files change outside Tessel too: rescan when the window gets the focus back.
    const onFocus = () => void refreshLibrary(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => setLimit(PAGE), [source, namespace, folder, search]);

  const all = useMemo(() => scans.flatMap((s) => s.entries), [scans]);
  const inSource = useMemo(() => (source === 'all' ? all : all.filter((e) => e.source === source)), [all, source]);
  const tree = useMemo(() => libraryTree(inSource), [inSource]);
  const shown = useMemo(() => filterEntries(inSource, { namespace: namespace ?? undefined, folder: folder ?? undefined, search }), [inSource, namespace, folder, search]);
  // The first entry of a location wins (project before folders before vanilla); later ones are shadowed.
  const winners = useMemo(() => {
    const first = new Map<string, LibraryEntry>();
    for (const entry of filterEntries(all, {})) if (!first.has(entry.location)) first.set(entry.location, entry);
    return first;
  }, [all]);
  const problems = scans.filter((s) => s.error || s.truncated);
  const current = scans.find((s) => s.source.id === source);

  return (
    <aside
      aria-label={t.title}
      className={`flex min-h-0 min-w-0 flex-col border-r border-line bg-panel ${dropping ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDropping(true);
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDropping(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) useLibraryUi.setState({ importing: files });
      }}
    >
      <header className="flex h-8 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.title}</h2>
        <div className="flex items-center">
          <IconButton label={t.import} icon={ImagePlus} onClick={() => input.current?.click()} />
          <IconButton label={t.addFolder} icon={FolderPlus} onClick={() => addFolder(t.chooseFolder)} />
          <IconButton label={t.refresh} icon={RefreshCw} spin={busy} onClick={() => refreshLibrary(true)} />
          <IconButton label={t.close} icon={PanelLeftClose} onClick={() => setLibraryPanelOpen(false)} />
        </div>
      </header>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          if (files.length > 0) useLibraryUi.setState({ importing: files });
          e.currentTarget.value = '';
        }}
      />
      {relink && (
        <div className="mx-1.5 mb-1.5 flex shrink-0 items-center gap-1.5 rounded-md bg-accent/12 px-2 py-1.5 text-[calc(12px*var(--font-scale))] text-text">
          <Link2 size={13} strokeWidth={1.75} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">{t.relinkHint(relink.name)}</span>
          <button aria-label={t.cancel} className={iconButton} onClick={() => useLibraryUi.setState({ relink: null })}>
            <X size={13} />
          </button>
        </div>
      )}
      <ProjectDefaults />
      <div className="flex shrink-0 items-center gap-1 px-1.5 pb-1.5">
        <select
          aria-label={t.source}
          value={source}
          className={`${fieldClass} w-auto max-w-[45%] shrink-0`}
          onChange={(e) => useLibraryUi.setState({ source: e.currentTarget.value, namespace: null, folder: null })}
        >
          <option value="all">{t.allSources}</option>
          {scans.map((s) => (
            <option key={s.source.id} value={s.source.id} disabled={!s.source.available}>
              {s.source.kind === 'project' ? t.projectSource(s.source.name) : s.source.name}
            </option>
          ))}
        </select>
        <label className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-faint" />
          <input
            aria-label={t.search}
            placeholder={t.search}
            value={search}
            spellCheck={false}
            className={`${fieldClass} pl-6`}
            onChange={(e) => useLibraryUi.setState({ search: e.currentTarget.value })}
          />
        </label>
        {current?.source.kind === 'folder' && (
          <IconButton label={t.forgetFolder} icon={Trash2} onClick={() => execute('library.remove_folder', { id: current.source.id }).then(() => useLibraryUi.setState({ source: 'all' }), notifyError)} />
        )}
      </div>
      {problems.map((s) => (
        <p key={s.source.id} className="shrink-0 px-3 pb-1 text-[calc(11.5px*var(--font-scale))] text-danger">
          {s.error ? t.sourceError(s.source.name, s.error) : t.truncated(s.source.name)}
        </p>
      ))}
      {tree.length > 0 && <Tree tree={tree} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {shown.length === 0 ? (
          <p className="px-1.5 py-2 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{all.length === 0 ? t.empty : t.noMatch}</p>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(3.6rem,1fr))] gap-0.5">
              {shown.slice(0, limit).map((entry) => (
                <Tile key={`${entry.source}|${entry.file}`} entry={entry} shadowed={winners.get(entry.location) !== entry} />
              ))}
            </div>
            {shown.length > limit && (
              <button className="mt-1 h-7 w-full rounded-md text-[calc(12px*var(--font-scale))] text-dim hover:bg-raised hover:text-text" onClick={() => setLimit(limit + PAGE)}>
                {t.showMore(shown.length - limit)}
              </button>
            )}
          </>
        )}
      </div>
      <footer className="tnum shrink-0 border-t border-line px-3 py-1 text-[calc(11px*var(--font-scale))] text-faint">{t.count(shown.length, all.length)}</footer>
      <LibraryDialogs />
    </aside>
  );
}
