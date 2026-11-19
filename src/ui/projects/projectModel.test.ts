import { describe, expect, it } from 'vitest';
import type { ProjectEntry } from '../../bridge/projects';
import { absolutePath, fileKind, folderForRepo, joinPath, movedPath, nameProblem, parentOf, relativeTo, stemOf, treeRows, withExtension } from './projectModel';

const entry = (path: string, kind: 'dir' | 'file' = 'file'): ProjectEntry => ({ name: path.split('/').pop()!, path, kind, size: 0, modified: 0 });

describe('project paths', () => {
  it('joins and splits relative paths', () => {
    expect(joinPath('', 'chair.tessel')).toBe('chair.tessel');
    expect(joinPath('models/props', 'chair.tessel')).toBe('models/props/chair.tessel');
    expect(parentOf('models/props/chair.tessel')).toBe('models/props');
    expect(parentOf('chair.tessel')).toBe('');
    expect(stemOf('models/chair.tessel')).toBe('chair');
    expect(stemOf('.hidden')).toBe('.hidden');
    expect(withExtension('chair', 'tessel')).toBe('chair.tessel');
    expect(withExtension('chair.TESSEL', 'tessel')).toBe('chair.TESSEL');
  });

  it('builds absolute paths with the separator of the project folder', () => {
    expect(absolutePath('C:\\Teams\\survival', 'models/chair.tessel')).toBe('C:\\Teams\\survival\\models\\chair.tessel');
    expect(absolutePath('/home/me/survival/', 'models/chair.tessel')).toBe('/home/me/survival/models/chair.tessel');
    expect(absolutePath('/home/me/survival', '')).toBe('/home/me/survival');
  });

  it('recognises files inside the project folder only', () => {
    expect(relativeTo('C:\\Teams\\survival', 'c:\\teams\\Survival\\models\\chair.tessel')).toBe('models/chair.tessel');
    expect(relativeTo('C:\\Teams\\survival', 'C:\\Teams\\survival-old\\chair.tessel')).toBeNull();
    expect(relativeTo('/home/me/survival', '/home/me/survival/a.tessel')).toBe('a.tessel');
    expect(relativeTo('/home/me/survival', '/home/me/Survival/a.tessel')).toBeNull();
  });

  it('follows renamed folders', () => {
    expect(movedPath('models/props/chair.tessel', 'models/props', 'models/furniture')).toBe('models/furniture/chair.tessel');
    expect(movedPath('models/props', 'models/props', 'models/furniture')).toBe('models/furniture');
    expect(movedPath('models/props2/x.tessel', 'models/props', 'models/furniture')).toBe('models/props2/x.tessel');
  });

  it('checks names before asking the desktop side', () => {
    expect(nameProblem('  ')).toBe('empty');
    expect(nameProblem('a/b')).toBe('invalid');
    expect(nameProblem('what?')).toBe('invalid');
    expect(nameProblem('..')).toBe('invalid');
    expect(nameProblem('Oak Planks')).toBeNull();
  });

  it('names a clone after its repository and sorts files into kinds', () => {
    expect(folderForRepo('team/survival-models')).toBe('survival-models');
    expect(fileKind('chair.tessel')).toBe('tessel');
    expect(fileKind('stairs.json')).toBe('model');
    expect(fileKind('oak.PNG')).toBe('image');
    expect(fileKind('scan.glb')).toBe('mesh');
    expect(fileKind('pack.mcmeta')).toBe('data');
  });
});

describe('tree rows', () => {
  it('shows the contents of expanded folders only, indented', () => {
    const entries = {
      '': [entry('assets', 'dir'), entry('models', 'dir'), entry('readme.json')],
      assets: [entry('assets/survival', 'dir')],
      'assets/survival': [entry('assets/survival/oak.png')],
      models: [entry('models/chair.tessel')],
    };
    const rows = treeRows(entries, new Set(['assets', 'assets/survival']));
    expect(rows.map((r) => [r.entry.path, r.depth, r.expanded])).toEqual([
      ['assets', 0, true],
      ['assets/survival', 1, true],
      ['assets/survival/oak.png', 2, false],
      ['models', 0, false],
      ['readme.json', 0, false],
    ]);
  });
});
