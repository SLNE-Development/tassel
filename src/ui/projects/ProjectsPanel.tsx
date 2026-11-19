import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Box,
  Braces,
  Check,
  ChevronRight,
  ChevronsUpDown,
  CloudDownload,
  Ellipsis,
  ExternalLink,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitCommitHorizontal,
  Image,
  LoaderCircle,
  PanelLeftClose,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { selectActiveDoc, useApp } from '../../app/store';
import { projectsApi, type GitFileStatus } from '../../bridge/projects';
import { useT } from '../../i18n';
import { itemClass, popupClass } from '../menu';
import { Tip } from '../Tip';
import { notifyError } from '../toast';
import { fileKind, relativeTo, treeRows, type FileKind } from './projectModel';
import {
  activeProject,
  addProjectFolder,
  loadAccount,
  loadProjects,
  openEntry,
  pull,
  push,
  refreshTree,
  removeProject,
  selectProject,
  setPanelOpen,
  targetDir,
  toggleDir,
  useProjects,
} from './projectsStore';

const INDENT = 14;
const iconButton =
  'flex size-6.5 shrink-0 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/50';
const textButton =
  'flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[calc(12.5px*var(--font-scale))] text-dim hover:bg-raised hover:text-text disabled:pointer-events-none disabled:text-faint/60';

const kindIcons: Record<FileKind, LucideIcon> = { tessel: Box, model: Braces, image: Image, mesh: Box, data: File };

/** Letter and colour of a git status, like other editors show them. */
const gitMarks: Record<GitFileStatus, { letter: string; className: string }> = {
  new: { letter: 'N', className: 'text-ok' },
  modified: { letter: 'M', className: 'text-accent' },
  deleted: { letter: 'D', className: 'text-danger' },
  renamed: { letter: 'R', className: 'text-accent' },
  typechange: { letter: 'T', className: 'text-accent' },
  conflicted: { letter: '!', className: 'text-danger' },
};

function IconButton({ label, icon: Icon, onClick, disabled, spin }: { label: string; icon: LucideIcon; onClick(): unknown; disabled?: boolean; spin?: boolean }) {
  return (
    <Tip label={label}>
      <button aria-label={label} className={iconButton} disabled={disabled} onClick={() => void onClick()}>
        <Icon size={14} strokeWidth={1.75} className={spin ? 'animate-spin motion-reduce:animate-none' : ''} />
      </button>
    </Tip>
  );
}

function ProjectPicker() {
  const t = useT().projects;
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects((s) => s.activeId);
  const active = projects.find((p) => p.id === activeId);
  return (
    <Menu.Root>
      <Menu.Trigger className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[calc(13px*var(--font-scale))] font-medium text-text hover:bg-raised data-[popup-open]:bg-raised">
        <FolderGit2 size={14} strokeWidth={1.75} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">{active?.name ?? t.choose}</span>
        <ChevronsUpDown size={13} className="shrink-0 opacity-60" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="start" sideOffset={4} className="z-50 outline-none">
          <Menu.Popup className={`${popupClass} max-w-80`}>
            {projects.map((project) => (
              <Menu.Item key={project.id} className={itemClass} onClick={() => void selectProject(project.id)}>
                <span className="flex w-4 shrink-0 justify-center">{project.id === activeId && <Check size={14} strokeWidth={2.25} />}</span>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {!project.exists && <span className="text-[calc(11.5px*var(--font-scale))] text-danger">{t.missingShort}</span>}
              </Menu.Item>
            ))}
            {projects.length > 0 && <Menu.Separator className="mx-1 my-1 h-px bg-line-strong" />}
            <Menu.Item className={itemClass} onClick={() => void addProjectFolder()}>
              <FolderPlus size={14} strokeWidth={1.75} />
              <span>{t.addFolder}</span>
            </Menu.Item>
            <Menu.Item className={itemClass} onClick={() => useProjects.setState({ githubOpen: true })}>
              <CloudDownload size={14} strokeWidth={1.75} />
              <span>{t.cloneFromGitHub}</span>
            </Menu.Item>
            {active && (
              <>
                <Menu.Separator className="mx-1 my-1 h-px bg-line-strong" />
                <Menu.Item className={itemClass} onClick={() => projectsApi.reveal(active.id).catch(notifyError)}>
                  <ExternalLink size={14} strokeWidth={1.75} />
                  <span>{t.reveal}</span>
                </Menu.Item>
                <Menu.Item className={itemClass} onClick={() => void removeProject(active.id)}>
                  <Trash2 size={14} strokeWidth={1.75} />
                  <span>{t.forget}</span>
                </Menu.Item>
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Branch, ahead / behind and the pull / commit / push buttons of a git project. */
function GitBar() {
  const t = useT().projects;
  const status = useProjects((s) => s.status);
  const busy = useProjects((s) => s.busy);
  if (!status?.isRepo) return null;
  const changes = status.files.length;
  return (
    <div className="flex shrink-0 items-center gap-0.5 border-b border-line px-1.5 py-1">
      <Tip label={t.branches}>
        <button className={`${textButton} min-w-0 flex-1`} disabled={busy !== null} onClick={() => useProjects.setState({ branchOpen: true })}>
          <GitBranch size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 truncate">{status.branch ?? t.detached}</span>
          {(status.ahead > 0 || status.behind > 0) && (
            <span className="tnum ml-auto shrink-0 text-faint">
              {status.behind > 0 && `↓${status.behind}`} {status.ahead > 0 && `↑${status.ahead}`}
            </span>
          )}
        </button>
      </Tip>
      <IconButton label={t.pull} icon={busy === 'pull' ? LoaderCircle : ArrowDownToLine} spin={busy === 'pull'} disabled={busy !== null || !status.remote} onClick={pull} />
      <Tip label={changes > 0 ? t.commitChanges(changes) : t.nothingToCommit}>
        <button
          aria-label={t.commit}
          className={`${textButton} px-1.5 ${changes > 0 ? 'text-accent' : ''}`}
          disabled={busy !== null || changes === 0}
          onClick={() => useProjects.setState({ commitOpen: true })}
        >
          <GitCommitHorizontal size={14} strokeWidth={1.75} />
          {changes > 0 && <span className="tnum">{changes}</span>}
        </button>
      </Tip>
      <IconButton label={t.push} icon={busy === 'push' ? LoaderCircle : ArrowUpFromLine} spin={busy === 'push'} disabled={busy !== null || !status.remote} onClick={push} />
    </div>
  );
}

function EntryMenuItems({ path, isDir }: { path: string; isDir: boolean }) {
  const t = useT().projects;
  const project = activeProject();
  const item = (icon: LucideIcon, title: string, run: () => unknown, shortcut?: string) => {
    const Icon = icon;
    return (
      <ContextMenu.Item className={itemClass} onClick={() => void Promise.resolve(run()).catch(notifyError)}>
        <Icon size={14} strokeWidth={1.75} />
        <span>{title}</span>
        {shortcut && <span className="tnum ml-auto pl-6 text-[calc(12px*var(--font-scale))] opacity-60">{shortcut}</span>}
      </ContextMenu.Item>
    );
  };
  return (
    <>
      {!isDir && item(FolderOpen, t.open, () => openEntry(path), '↵')}
      {item(FolderPlus, t.newFolder, () => useProjects.setState({ prompt: { kind: 'newFolder', dir: targetDir() } }))}
      {item(Save, t.saveInto, () => useProjects.setState({ prompt: { kind: 'saveInto', dir: targetDir() } }))}
      <ContextMenu.Separator className="mx-1 my-1 h-px bg-line-strong" />
      {item(PencilLine, t.rename, () => useProjects.setState({ prompt: { kind: 'rename', path, isDir } }), 'F2')}
      {project && item(ExternalLink, t.reveal, () => projectsApi.reveal(project.id, path))}
      <ContextMenu.Separator className="mx-1 my-1 h-px bg-line-strong" />
      {item(Trash2, t.trash, () => useProjects.setState({ trashPath: path }), t.deleteKey)}
    </>
  );
}

function Tree() {
  const t = useT().projects;
  const entries = useProjects((s) => s.entries);
  const expanded = useProjects((s) => s.expanded);
  const selected = useProjects((s) => s.selected);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeId));
  const activeFile = useApp((s) => selectActiveDoc(s).filePath);
  const rows = useMemo(() => treeRows(entries, expanded), [entries, expanded]);
  const openPath = project && activeFile ? relativeTo(project.path, activeFile) : null;
  const menuRow = rows.find((row) => row.entry.path === selected);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.entry.path === selected);
    const row = rows[index];
    const move = (to: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (next) useProjects.setState({ selected: next.entry.path });
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index < 0 ? 0 : index - 1);
    else if (!row) return;
    else if (e.key === 'Enter') void (row.entry.kind === 'dir' ? toggleDir(row.entry.path) : openEntry(row.entry.path));
    else if (e.key === 'ArrowRight' && row.entry.kind === 'dir' && !row.expanded) void toggleDir(row.entry.path);
    else if (e.key === 'ArrowLeft' && row.expanded) void toggleDir(row.entry.path);
    else if (e.key === 'F2') useProjects.setState({ prompt: { kind: 'rename', path: row.entry.path, isDir: row.entry.kind === 'dir' } });
    else if (e.key === 'Delete') useProjects.setState({ trashPath: row.entry.path });
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (rows.length === 0) {
    return <p className="px-3 py-3 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{t.emptyFolder}</p>;
  }
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        role="tree"
        aria-label={t.files}
        tabIndex={0}
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2 outline-none"
        onKeyDown={onKeyDown}
      >
        {rows.map(({ entry, depth, expanded: open }) => {
          const Icon = entry.kind === 'dir' ? (open ? FolderOpen : Folder) : kindIcons[fileKind(entry.name)];
          const isSelected = entry.path === selected;
          const mark = entry.git ? gitMarks[entry.git] : null;
          return (
            <div
              key={entry.path}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={entry.kind === 'dir' ? open : undefined}
              title={entry.path}
              className={`group flex h-6.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pr-1.5 text-[calc(12.5px*var(--font-scale))] ${
                isSelected ? 'bg-accent/12 text-text' : 'text-dim hover:bg-raised hover:text-text'
              }`}
              style={{ paddingLeft: 4 + depth * INDENT }}
              onPointerDown={() => useProjects.setState({ selected: entry.path })}
              onClick={() => entry.kind === 'dir' && void toggleDir(entry.path)}
              onDoubleClick={() => entry.kind === 'file' && void openEntry(entry.path)}
              onContextMenu={() => useProjects.setState({ selected: entry.path })}
            >
              <ChevronRight
                size={12}
                strokeWidth={2}
                className={`shrink-0 text-faint transition-transform duration-100 motion-reduce:transition-none ${entry.kind === 'dir' ? '' : 'invisible'} ${open ? 'rotate-90' : ''}`}
              />
              <Icon size={14} strokeWidth={1.75} className={`shrink-0 ${entry.path === openPath ? 'text-accent' : 'text-faint'}`} />
              <span className={`min-w-0 flex-1 truncate ${entry.git === 'deleted' ? 'line-through' : ''}`}>{entry.name}</span>
              {mark && (
                <span className={`tnum shrink-0 text-[calc(11px*var(--font-scale))] font-semibold ${mark.className}`} title={t.gitStatus[entry.git!]}>
                  {mark.letter}
                </span>
              )}
            </div>
          );
        })}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50 outline-none">
          <ContextMenu.Popup className={popupClass}>{menuRow && <EntryMenuItems path={menuRow.entry.path} isDir={menuRow.entry.kind === 'dir'} />}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2 px-3 py-3 text-[calc(12.5px*var(--font-scale))] leading-relaxed text-faint">{children}</div>;
}

/** The Projects sidebar: project picker, git bar and the file tree of the active project. */
export function ProjectsPanel() {
  const t = useT().projects;
  const projects = useProjects((s) => s.projects);
  const project = useProjects((s) => s.projects.find((p) => p.id === s.activeId));
  const busy = useProjects((s) => s.busy);

  useEffect(() => {
    void loadProjects();
    void loadAccount();
    // Files change outside Tessel too (other editors, git): refresh when the window gets the focus back.
    const onFocus = () => void refreshTree();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <aside aria-label={t.title} className="flex min-h-0 min-w-0 flex-col border-r border-line bg-panel">
      <header className="flex h-8 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-[calc(12px*var(--font-scale))] font-semibold text-dim">{t.title}</h2>
        <div className="flex items-center">
          <IconButton label={t.github} icon={CloudDownload} onClick={() => useProjects.setState({ githubOpen: true })} />
          <IconButton label={t.close} icon={PanelLeftClose} onClick={() => setPanelOpen(false)} />
        </div>
      </header>
      {projects.length === 0 ? (
        <Empty>
          <p>{t.none}</p>
          <button className={`${textButton} self-start text-text ring-1 ring-line-strong ring-inset`} onClick={() => void addProjectFolder()}>
            <FolderPlus size={14} strokeWidth={1.75} />
            {t.addFolder}
          </button>
          <button className={`${textButton} self-start text-text ring-1 ring-line-strong ring-inset`} onClick={() => useProjects.setState({ githubOpen: true })}>
            <CloudDownload size={14} strokeWidth={1.75} />
            {t.cloneFromGitHub}
          </button>
        </Empty>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-0.5 px-1.5 pb-1">
            <ProjectPicker />
          </div>
          {project && !project.exists ? (
            <Empty>
              <p className="text-danger">{t.missing(project.path)}</p>
            </Empty>
          ) : (
            project && (
              <>
                <GitBar />
                <div className="flex shrink-0 items-center gap-0.5 px-1.5 py-1">
                  <IconButton label={t.saveInto} icon={Save} onClick={() => useProjects.setState({ prompt: { kind: 'saveInto', dir: targetDir() } })} />
                  <IconButton label={t.newFolder} icon={FolderPlus} onClick={() => useProjects.setState({ prompt: { kind: 'newFolder', dir: targetDir() } })} />
                  <div className="flex-1" />
                  <IconButton label={t.refresh} icon={RefreshCw} spin={busy === 'refresh'} onClick={refreshTree} />
                  <Menu.Root>
                    <Menu.Trigger aria-label={t.more} className={iconButton}>
                      <Ellipsis size={14} strokeWidth={1.75} />
                    </Menu.Trigger>
                    <Menu.Portal>
                      <Menu.Positioner align="end" sideOffset={4} className="z-50 outline-none">
                        <Menu.Popup className={popupClass}>
                          <Menu.Item className={itemClass} onClick={() => projectsApi.reveal(project.id).catch(notifyError)}>
                            <ExternalLink size={14} strokeWidth={1.75} />
                            <span>{t.reveal}</span>
                          </Menu.Item>
                          <Menu.Item className={itemClass} onClick={() => void addProjectFolder()}>
                            <Plus size={14} strokeWidth={1.75} />
                            <span>{t.addFolder}</span>
                          </Menu.Item>
                        </Menu.Popup>
                      </Menu.Positioner>
                    </Menu.Portal>
                  </Menu.Root>
                </div>
                <Tree />
              </>
            )
          )}
        </>
      )}
    </aside>
  );
}
