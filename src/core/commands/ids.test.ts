import { describe, expect, it } from 'vitest';
import { createAppState } from '../state';
import type { AppState } from '../types';
import { commandsById } from './index';
import { runCommand, type CommandContext } from './registry';

describe('ids that are Object.prototype keys', () => {
  it('are treated as unknown ids, not as existing entries', async () => {
    let app: AppState = createAppState();
    const ctx: CommandContext = {
      get: () => app,
      set: (update) => {
        app = update(app);
      },
      services: { viewport: null, exporter: null } as CommandContext['services'],
    };
    const run = (id: string, params?: unknown) => runCommand(commandsById.get(id)!, ctx, params);

    for (const id of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      await expect(run('scene.get_object', { id })).rejects.toThrow('does not exist');
      await expect(run('scene.select', { ids: [id] })).rejects.toThrow('does not exist');
      await expect(run('document.switch', { id })).rejects.toThrow('does not exist');
      await expect(run('edit.enter', { id })).rejects.toThrow('does not exist');
      await expect(run('modifier.add', { objectId: id, type: 'mirror' })).rejects.toThrow('does not exist');
      await expect(run('material.update', { id, roughness: 0.5 })).rejects.toThrow('does not exist');
      await expect(run('texture.remove', { id })).rejects.toThrow('does not exist');
      await expect(run('group.rename', { id, name: 'x' })).rejects.toThrow('does not exist');
      await expect(run('uv.unwrap', { objectId: id })).rejects.toThrow('does not exist');
      await expect(run('scene.add_primitive', { type: 'cube', materialId: id })).rejects.toThrow('does not exist');
      await expect(run('scene.add_primitive', { type: 'cube', groupId: id })).rejects.toThrow('does not exist');
    }
  });
});
