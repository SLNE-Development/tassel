// The Projects panel's actions against a fake desktop side: what is written where, and what the editor does with it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, useApp } from '../../app/store';
import { createAppState } from '../../core/state';

const ROOT = 'C:\\Teams\\survival';
let files: Record<string, string>;
let calls: { command: string; args: Record<string, unknown> }[];

const project = { id: 'p1', name: 'Survival', path: ROOT, remote: 'https://github.com/team/survival.git', exists: true, isRepo: true, branch: 'main' };

function listDir(dir: string) {
  const prefix = dir ? `${dir}/` : '';
  const names = new Map<string, 'dir' | 'file'>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(prefix)) continue;
    const [name, ...rest] = path.slice(prefix.length).split('/');
    names.set(name, rest.length ? 'dir' : 'file');
  }
  return [...names].map(([name, kind]) => ({ name, path: prefix + name, kind, size: 0, modified: 0 }));
}

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    switch (command) {
      case 'project_list':
        return [project];
      case 'project_list_dir':
        return listDir(args.dir as string);
      case 'project_read_text':
        return files[args.path as string];
      case 'project_write_text':
        files[args.path as string] = args.contents as string;
        return `${ROOT}\\${(args.path as string).replace(/\//g, '\\')}`;
      case 'project_move': {
        const from = args.from as string;
        const to = args.to as string;
        for (const path of Object.keys(files)) {
          if (path === from || path.startsWith(`${from}/`)) {
            files[to + path.slice(from.length)] = files[path];
            delete files[path];
          }
        }
        return to;
      }
      case 'git_status':
        return { isRepo: true, branch: 'main', detached: false, upstream: 'origin/main', ahead: 0, behind: 0, remote: project.remote, state: 'clean', files: [] };
      case 'git_commit':
        return { commit: 'abc', branch: 'main', files: 2 };
      default:
        throw new Error(`unexpected command ${command}`);
    }
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: async () => null, save: async () => null }));

const store = await import('./projectsStore');
const { useProjects } = store;

const doc = () => useApp.getState().docs[useApp.getState().activeDocId];

beforeEach(async () => {
  useApp.setState(createAppState(), true);
  files = { 'models/chair.tessel': '' };
  calls = [];
  useProjects.setState({ projects: [], activeId: null, entries: {}, expanded: new Set(), selected: null, status: null, busy: null });
  // A real document file, so that opening it works.
  files['models/chair.tessel'] = ((await execute('document.serialize', {})) as { json: string }).json;
  await store.loadProjects();
});

describe('projects panel', () => {
  it('selects the first project and loads its tree and git status', () => {
    expect(useProjects.getState().activeId).toBe('p1');
    expect(useProjects.getState().entries['']!.map((e) => e.path)).toEqual(['models']);
    expect(useProjects.getState().status?.branch).toBe('main');
  });

  it('saves the active document into the project and keeps it tied to the file', async () => {
    await execute('scene.add_primitive', { type: 'cube' });
    expect(await store.saveIntoProject('models/props', 'Lamp')).toBe(true);
    expect(JSON.parse(files['models/props/Lamp.tessel']!)).toBeTruthy();
    expect(doc().filePath).toBe(`${ROOT}\\models\\props\\Lamp.tessel`);
    expect(doc().name).toBe('Lamp');
    expect(doc().dirty).toBe(false);
    expect(useProjects.getState().expanded.has('models/props')).toBe(true);
  });

  it('opens a document once and switches to it the second time', async () => {
    await store.openEntry('models/chair.tessel');
    const opened = doc();
    expect(opened.filePath).toBe(`${ROOT}\\models\\chair.tessel`);
    const count = Object.keys(useApp.getState().docs).length;
    await execute('document.new', {});
    await store.openEntry('models/chair.tessel');
    expect(useApp.getState().activeDocId).toBe(opened.id);
    expect(Object.keys(useApp.getState().docs).length).toBe(count + 1);
  });

  it('hands files of other kinds to registered openers', async () => {
    files['assets/survival/models/block/stairs.json'] = '{"parent":"block/block"}';
    const seen: string[] = [];
    const unregister = store.registerProjectFileOpener('.json', async (file) => {
      seen.push(`${file.path} ${await file.readText()}`);
      return true;
    });
    await store.openEntry('assets/survival/models/block/stairs.json');
    unregister();
    expect(seen).toEqual(['assets/survival/models/block/stairs.json {"parent":"block/block"}']);
  });

  it('moves open documents along with a renamed folder', async () => {
    await store.openEntry('models/chair.tessel');
    await store.renameEntry('models', 'furniture', true);
    expect(files['furniture/chair.tessel']).toBeDefined();
    expect(doc().filePath).toBe(`${ROOT}\\furniture\\chair.tessel`);
  });

  it('keeps the extension when a file is renamed without one', async () => {
    await store.renameEntry('models/chair.tessel', 'stool', false);
    expect(calls.find((c) => c.command === 'project_move')!.args).toMatchObject({ from: 'models/chair.tessel', to: 'models/stool.tessel' });
  });

  it('commits all files without a list and only the chosen ones with one', async () => {
    await store.commit('Add chair', undefined, false);
    await store.commit('Some', ['models/chair.tessel'], false);
    const commits = calls.filter((c) => c.command === 'git_commit').map((c) => c.args);
    expect(commits).toEqual([
      { projectId: 'p1', message: 'Add chair', files: undefined },
      { projectId: 'p1', message: 'Some', files: ['models/chair.tessel'] },
    ]);
  });

  it('never sends or receives a token', () => {
    const json = JSON.stringify(calls);
    expect(json).not.toMatch(/token/i);
  });
});
