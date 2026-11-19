import { describe, expect, it } from 'vitest';
import { commands } from '../core/commands';
import { addDoc, createAppState, createDoc } from '../core/state';
import { buildManifest, splitDocumentId, workedDocument } from './mcp';

interface Schema {
  type: string;
  properties: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

describe('MCP manifest', () => {
  const manifest = buildManifest();

  it('has one tool per command', () => {
    expect(manifest.map((entry) => entry.id)).toEqual(commands.map((c) => c.id));
    expect(manifest.find((entry) => entry.id === 'scene.add_primitive')?.name).toBe('scene_add_primitive');
  });

  it('advertises the optional documentId on every tool', () => {
    for (const entry of manifest) {
      const schema = entry.inputSchema as Schema;
      expect(schema.type, entry.id).toBe('object');
      expect(schema.properties.documentId, entry.id).toMatchObject({ type: 'string', description: expect.stringMatching(/^Optional/) });
      expect(schema.required ?? [], entry.id).not.toContain('documentId');
    }
  });

  it('says per tool what documentId does, and keeps the other properties', () => {
    const description = (id: string) => (manifest.find((entry) => entry.id === id)!.inputSchema as Schema).properties.documentId.description;
    expect(description('scene.add_primitive')).toContain('instead of the active one, without switching tabs');
    expect(description('view.screenshot')).toContain('instead of the active one, without switching tabs');
    expect(description('view.set_shading')).toContain('a documentId other than the visible document is rejected');
    expect(description('app.get_state')).toContain('to report on');
    expect(description('document.serialize')).toContain('same as "id"');
    expect(description('preferences.get')).toContain('ignored');
    const add = manifest.find((entry) => entry.id === 'scene.add_primitive')!.inputSchema as Schema;
    expect(Object.keys(add.properties)).toEqual(expect.arrayContaining(['type', 'name', 'position', 'groupId', 'materialId', 'documentId']));
    expect(add.required).toEqual(['type']);
  });
});

describe('splitDocumentId', () => {
  it('takes documentId out of the params', () => {
    expect(splitDocumentId('scene.select_all', { documentId: 'abc12345' })).toEqual({ params: {}, documentId: 'abc12345' });
    expect(splitDocumentId('scene.add_primitive', { type: 'cube', documentId: 'abc12345' })).toEqual({ params: { type: 'cube' }, documentId: 'abc12345' });
  });

  it('leaves calls without it alone', () => {
    const params = { type: 'cube' };
    expect(splitDocumentId('scene.add_primitive', params)).toEqual({ params });
    expect(splitDocumentId('scene.add_primitive', params).params).toBe(params);
    expect(splitDocumentId('scene.select_all', {})).toEqual({ params: {} });
    expect(splitDocumentId('scene.select_all', null)).toEqual({ params: null });
    expect(splitDocumentId('scene.select_all', [1])).toEqual({ params: [1] });
    expect(splitDocumentId('scene.select_all', { documentId: null })).toEqual({ params: {} });
    expect(splitDocumentId('scene.select_all', { documentId: undefined })).toEqual({ params: {} });
  });

  it('rejects a documentId that is not a string', () => {
    expect(() => splitDocumentId('scene.select_all', { documentId: 5 })).toThrow('documentId must be a string');
    expect(() => splitDocumentId('scene.select_all', { documentId: {} })).toThrow('documentId must be a string');
  });

  it('does not look at inherited properties', () => {
    const params = Object.create({ documentId: 'abc12345' }) as Record<string, unknown>;
    expect(splitDocumentId('scene.select_all', params)).toEqual({ params });
  });
});

describe('app.get_state through the bridge', () => {
  it('keeps documentId as the parameter of the command', () => {
    expect(splitDocumentId('app.get_state', { documentId: 'abc12345' })).toEqual({ params: { documentId: 'abc12345' } });
  });
});

describe('workedDocument', () => {
  const app = (() => {
    const first = createAppState();
    return addDoc(first, createDoc('Stone'));
  })();
  const [tree, stone] = app.docOrder;

  it('is the targeted document, or the visible one without documentId', () => {
    expect(app.activeDocId).toBe(stone);
    expect(workedDocument(app, 'scene.add_primitive', { type: 'cube' }, tree)).toBe(tree);
    expect(workedDocument(app, 'scene.add_primitive', { type: 'cube' })).toBe(stone);
    expect(workedDocument(app, 'view.screenshot', {}, tree)).toBe(tree);
    expect(workedDocument(app, 'history.undo', null, tree)).toBe(tree);
  });

  it('follows the id of commands that name their document', () => {
    expect(workedDocument(app, 'document.serialize', { id: tree })).toBe(tree);
    expect(workedDocument(app, 'document.serialize', {}, tree)).toBe(tree);
    expect(workedDocument(app, 'document.serialize', { id: tree }, stone)).toBe(tree);
    expect(workedDocument(app, 'document.mark_saved', {})).toBe(stone);
    expect(workedDocument(app, 'app.get_state', { documentId: tree })).toBe(tree);
  });

  it('is null for calls that are not about one open document', () => {
    expect(workedDocument(app, 'app.get_state', {})).toBeNull();
    expect(workedDocument(app, 'document.list', {}, tree)).toBeNull();
    expect(workedDocument(app, 'document.new', { name: 'x' })).toBeNull();
    expect(workedDocument(app, 'preferences.get', {})).toBeNull();
    expect(workedDocument(app, 'scene.add_primitive', {}, 'nope')).toBeNull();
    expect(workedDocument(app, 'scene.add_primitive', {}, 'constructor')).toBeNull();
    expect(workedDocument(app, 'document.serialize', { id: 5 }, 'nope')).toBeNull();
  });
});
