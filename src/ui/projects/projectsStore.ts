import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { create } from 'zustand';
import { execute, selectActiveDoc, useApp } from '../../app/store';
import { gitApi, githubApi, projectsApi, type GitHubAccount, type ProjectEntry, type ProjectInfo, type RepoStatus } from '../../bridge/projects';
import { getT } from '../../i18n';
import { notifyError, notifyInfo, notifySuccess } from '../toast';
import { absolutePath, extensionOf, fileKind, joinPath, movedPath, parentOf, relativeTo, stemOf, withExtension } from './projectModel';

/** A dialog of the Projects panel that asks for a name. */
export type NamePrompt =
  | { kind: 'newFolder'; dir: string }
  | { kind: 'rename'; path: string; isDir: boolean }
  | { kind: 'saveInto'; dir: string };

export interface ProjectsState {
  panelOpen: boolean;
  projects: ProjectInfo[];
  activeId: string | null;
  /** Loaded folders of the active project by relative path ('' is the project folder). */
  entries: Record<string, ProjectEntry[]>;
  expanded: ReadonlySet<string>;
  /** Selected tree entry (relative path). */
  selected: string | null;
  status: RepoStatus | null;
  /** The git or GitHub operation running right now, for spinners and disabled buttons. */
  busy: 'pull' | 'push' | 'commit' | 'branch' | 'clone' | 'refresh' | null;
  account: GitHubAccount | null;
  githubOpen: boolean;
  commitOpen: boolean;
  branchOpen: boolean;
  prompt: NamePrompt | null;
  /** Entry waiting for the "move to trash" confirmation. */
  trashPath: string | null;
}

const PANEL_KEY = 'tessel.projects.open';
const ACTIVE_KEY = 'tessel.projects.active';

function stored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Remembering the panel state is a convenience only.
  }
}

export const useProjects = create<ProjectsState>(() => ({
  panelOpen: stored(PANEL_KEY) === '1',
  projects: [],
  activeId: stored(ACTIVE_KEY),
  entries: {},
  expanded: new Set<string>(),
  selected: null,
  status: null,
  busy: null,
  account: null,
  githubOpen: false,
  commitOpen: false,
  branchOpen: false,
  prompt: null,
  trashPath: null,
}));

const get = useProjects.getState;
const set = useProjects.setState;

export function activeProject(): ProjectInfo | null {
  const { projects, activeId } = get();
  return projects.find((p) => p.id === activeId) ?? null;
}

function requireProject(): ProjectInfo {
  const project = activeProject();
  if (!project) throw new Error(getT().projects.noProject);
  return project;
}

export function setPanelOpen(open: boolean): void {
  set({ panelOpen: open });
  store(PANEL_KEY, open ? '1' : '0');
  if (open) void loadProjects();
}

export function togglePanel(): void {
  setPanelOpen(!get().panelOpen);
}

/** Reloads the project list (and the active project's tree). */
export async function loadProjects(): Promise<void> {
  if (!isTauri()) return;
  try {
    const projects = await projectsApi.list();
    const activeId = projects.some((p) => p.id === get().activeId) ? get().activeId : (projects[0]?.id ?? null);
    set({ projects });
    if (activeId !== get().activeId || Object.keys(get().entries).length === 0) await selectProject(activeId);
    else await refreshTree();
  } catch (error) {
    notifyError(error);
  }
}

export async function selectProject(id: string | null): Promise<void> {
  set({ activeId: id, entries: {}, expanded: new Set(), selected: null, status: null });
  store(ACTIVE_KEY, id);
  await refreshTree();
}

/** Reloads every loaded folder and the git status of the active project. */
export async function refreshTree(): Promise<void> {
  const project = activeProject();
  if (!project || !project.exists) return;
  const dirs = ['', ...get().expanded];
  try {
    const loaded = await Promise.all(dirs.map(async (dir) => [dir, await projectsApi.listDir(project.id, dir).catch(() => null)] as const));
    const entries: Record<string, ProjectEntry[]> = {};
    const expanded = new Set(get().expanded);
    for (const [dir, list] of loaded) {
      if (list) entries[dir] = list;
      else expanded.delete(dir);
    }
    if (activeProject()?.id !== project.id) return;
    set({ entries, expanded });
    await refreshStatus();
  } catch (error) {
    notifyError(error);
  }
}

async function refreshStatus(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  const status = await gitApi.status(project.id).catch(() => null);
  if (activeProject()?.id !== project.id) return;
  set({
    status,
    projects: get().projects.map((p) => (p.id === project.id ? { ...p, branch: status?.branch ?? null, isRepo: status?.isRepo ?? false } : p)),
  });
}

export async function toggleDir(path: string): Promise<void> {
  const project = activeProject();
  if (!project) return;
  const expanded = new Set(get().expanded);
  if (expanded.has(path)) {
    expanded.delete(path);
    set({ expanded });
    return;
  }
  try {
    const list = await projectsApi.listDir(project.id, path);
    expanded.add(path);
    set({ expanded, entries: { ...get().entries, [path]: list } });
  } catch (error) {
    notifyError(error);
  }
}

/** Asks for a folder and registers it as a project. */
export async function addProjectFolder(): Promise<void> {
  const path = await open({ directory: true, multiple: false, title: getT().projects.chooseFolder });
  if (!path) return;
  try {
    const project = await projectsApi.add(path);
    set({ projects: [...get().projects.filter((p) => p.id !== project.id), project] });
    await selectProject(project.id);
  } catch (error) {
    notifyError(error);
  }
}

/** Forgets the project; the folder stays on disk. */
export async function removeProject(id: string): Promise<void> {
  try {
    await projectsApi.remove(id);
    const projects = get().projects.filter((p) => p.id !== id);
    set({ projects });
    if (get().activeId === id) await selectProject(projects[0]?.id ?? null);
  } catch (error) {
    notifyError(error);
  }
}

/** Projects registered after a clone show up and become the active one. */
export async function adoptProject(project: ProjectInfo): Promise<void> {
  set({ projects: [...get().projects.filter((p) => p.id !== project.id), project], panelOpen: true });
  store(PANEL_KEY, '1');
  await selectProject(project.id);
}

// ---- opening files -------------------------------------------------------------------------------

/**
 * Opens a project file of a kind Tessel has no built-in handling for (e.g. a Minecraft model .json).
 * Other modes register themselves here; the handler gets the project, the relative path and the text
 * or base64 reader. Returning false means "not mine", so the next handler (or the fallback) runs.
 */
export type ProjectFileOpener = (file: { project: ProjectInfo; path: string; absolutePath: string; readText(): Promise<string> }) => Promise<boolean> | boolean;

const openers = new Map<string, ProjectFileOpener[]>();

export function registerProjectFileOpener(extension: string, opener: ProjectFileOpener): () => void {
  const key = extension.toLowerCase().replace(/^\./, '');
  openers.set(key, [...(openers.get(key) ?? []), opener]);
  return () => openers.set(key, (openers.get(key) ?? []).filter((o) => o !== opener));
}

const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

async function imageSize(base64: string, mimeType: string): Promise<{ width: number; height: number }> {
  const blob = await (await fetch(`data:${mimeType};base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** Double-click on a file: documents open in a tab, images become textures, 3D files are imported. */
export async function openEntry(path: string): Promise<void> {
  const project = requireProject();
  const t = getT();
  const file = absolutePath(project.path, path);
  const name = path.split('/').pop() ?? path;
  try {
    for (const opener of openers.get(extensionOf(name)) ?? []) {
      if (await opener({ project, path, absolutePath: file, readText: () => projectsApi.readText(project.id, path) })) return;
    }
    switch (fileKind(name)) {
      case 'tessel': {
        const app = useApp.getState();
        const open = Object.values(app.docs).find((doc) => doc.filePath === file);
        if (open) {
          await execute('document.switch', { id: open.id });
          return;
        }
        const json = await projectsApi.readText(project.id, path);
        await execute('document.load', { json, filePath: file, name: stemOf(name) });
        return;
      }
      case 'image': {
        const mimeType = imageTypes[extensionOf(name) as keyof typeof imageTypes];
        const data = await projectsApi.readBinary(project.id, path);
        const { width, height } = await imageSize(data, mimeType);
        await execute('texture.add', { name: stemOf(name), mimeType, data, width, height });
        notifySuccess(t.projects.textureAdded, name);
        return;
      }
      case 'mesh': {
        const format = extensionOf(name);
        const base64 = await projectsApi.readBinary(project.id, path);
        const result = (await execute('import.file', { format, name, base64 })) as { objects: unknown[] };
        notifySuccess(t.files.imported, t.files.importedObjects(result.objects.length));
        return;
      }
      default:
        break;
    }
    notifyInfo(t.projects.noOpener(name), t.projects.noOpenerHint);
  } catch (error) {
    notifyError(error);
  }
}

// ---- file operations -----------------------------------------------------------------------------

/** The folder new things go into: the selected folder, or the folder of the selected file. */
export function targetDir(): string {
  const { selected, entries } = get();
  if (!selected) return '';
  const entry = Object.values(entries).flat().find((e) => e.path === selected);
  return entry?.kind === 'dir' ? entry.path : parentOf(selected);
}

export async function createFolder(dir: string, name: string): Promise<void> {
  const project = requireProject();
  const path = joinPath(dir, name.trim());
  try {
    await projectsApi.createDir(project.id, path);
    if (dir && !get().expanded.has(dir)) await toggleDir(dir);
    set({ selected: path });
    await refreshTree();
  } catch (error) {
    notifyError(error);
  }
}

export async function renameEntry(from: string, newName: string, isDir: boolean): Promise<void> {
  const project = requireProject();
  const extension = extensionOf(from);
  const name = !isDir && extension && !extensionOf(newName) ? withExtension(newName.trim(), extension) : newName.trim();
  const to = joinPath(parentOf(from), name);
  if (to === from) return;
  try {
    await projectsApi.move(project.id, from, to);
    // Open documents that lived there follow the move.
    for (const doc of Object.values(useApp.getState().docs)) {
      const relative = doc.filePath ? relativeTo(project.path, doc.filePath) : null;
      if (relative === null) continue;
      const moved = movedPath(relative, from, to);
      if (moved === relative) continue;
      const filePath = absolutePath(project.path, moved);
      await execute('document.mark_saved', { id: doc.id, filePath, name: stemOf(moved) }).catch(() => undefined);
    }
    const expanded = new Set([...get().expanded].map((p) => movedPath(p, from, to)));
    set({ expanded, selected: to });
    await refreshTree();
  } catch (error) {
    notifyError(error);
  }
}

export async function trashEntry(path: string): Promise<void> {
  const project = requireProject();
  try {
    await projectsApi.trash(project.id, path);
    set({ selected: null });
    await refreshTree();
    notifySuccess(getT().projects.trashed, path.split('/').pop());
  } catch (error) {
    notifyError(error);
  }
}

/** Writes the active document as `dir/name.tessel` into the active project; it then belongs to that file. */
export async function saveIntoProject(dir: string, name: string): Promise<boolean> {
  const project = requireProject();
  const path = joinPath(dir, withExtension(name.trim(), 'tessel'));
  try {
    const current = selectActiveDoc(useApp.getState());
    const doc = (await execute('document.serialize', { id: current.id })) as { id: string; json: string };
    const filePath = await projectsApi.writeText(project.id, path, doc.json);
    await execute('document.mark_saved', { id: doc.id, filePath, name: stemOf(path) });
    if (dir && !get().expanded.has(dir)) await toggleDir(dir);
    set({ selected: path });
    await refreshTree();
    notifySuccess(getT().toasts.saved, path);
    return true;
  } catch (error) {
    notifyError(error);
    return false;
  }
}

// ---- git -----------------------------------------------------------------------------------------

async function gitOperation<T>(busy: NonNullable<ProjectsState['busy']>, run: (project: ProjectInfo) => Promise<T>): Promise<T | null> {
  const project = requireProject();
  if (get().busy) return null;
  set({ busy });
  try {
    return await run(project);
  } catch (error) {
    notifyError(error);
    return null;
  } finally {
    set({ busy: null });
    await refreshTree();
  }
}

/** Open documents of the project with unsaved changes: committing or pulling would miss or clash with them. */
export function dirtyProjectDocs(project: ProjectInfo | null = activeProject()): string[] {
  if (!project) return [];
  return Object.values(useApp.getState().docs)
    .filter((doc) => doc.dirty && doc.filePath !== null && relativeTo(project.path, doc.filePath) !== null)
    .map((doc) => doc.name);
}

export async function pull(): Promise<void> {
  const t = getT().projects;
  const result = await gitOperation('pull', (project) => gitApi.pull(project.id));
  if (!result) return;
  notifySuccess(t.pulled[result.result], result.branch);
  if (result.result !== 'up-to-date') await reloadOpenProjectDocs();
}

export async function push(): Promise<void> {
  const branch = await gitOperation('push', (project) => gitApi.push(project.id));
  if (branch) notifySuccess(getT().projects.pushed, branch);
}

export async function commit(message: string, files: string[] | undefined, andPush: boolean): Promise<boolean> {
  const result = await gitOperation('commit', (project) => gitApi.commit(project.id, message, files));
  if (!result) return false;
  notifySuccess(getT().projects.committed(result.files), message.split('\n')[0]);
  if (andPush) await push();
  return true;
}

export async function switchBranch(branch: string): Promise<void> {
  const switched = await gitOperation('branch', (project) => gitApi.switchBranch(project.id, branch));
  if (!switched) return;
  notifySuccess(getT().projects.switched, switched);
  await reloadOpenProjectDocs();
}

/**
 * After a pull or a branch switch, documents of the project that are open without unsaved changes
 * show what is on disk now: they are closed and opened again from their file.
 */
async function reloadOpenProjectDocs(): Promise<void> {
  const project = activeProject();
  if (!project) return;
  for (const doc of Object.values(useApp.getState().docs)) {
    const relative = doc.filePath ? relativeTo(project.path, doc.filePath) : null;
    if (relative === null || doc.dirty) continue;
    try {
      const json = await projectsApi.readText(project.id, relative);
      const wasActive = useApp.getState().activeDocId === doc.id;
      await execute('document.load', { json, filePath: doc.filePath, name: doc.name, activate: wasActive });
      await execute('document.close', { id: doc.id });
    } catch {
      // The file is gone on this branch: leave the document open as it is.
    }
  }
}

// ---- GitHub --------------------------------------------------------------------------------------

export async function loadAccount(): Promise<GitHubAccount | null> {
  if (!isTauri()) return null;
  try {
    const account = await githubApi.account();
    set({ account });
    return account;
  } catch (error) {
    notifyError(error);
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await githubApi.logout();
  } catch (error) {
    notifyError(error);
  }
  await loadAccount();
}
