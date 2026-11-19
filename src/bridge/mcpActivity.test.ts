// Every MCP-executed command notes the document it ran against (the activity indicator on the tabs).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentActivity } from '../app/agentActivity';
import { execute, useApp } from '../app/store';
import { createAppState } from '../core/state';

const responses: { requestId: string; ok: boolean; result: unknown; error: string | null }[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: async (_command: string, response: (typeof responses)[number]) => {
    responses.push(response);
  },
}));

const { handleCall } = await import('./mcp');

const active = () => Object.keys(useAgentActivity.getState().lastCall);
const call = async (command: string, params?: unknown) => {
  await handleCall({ requestId: 'r', command, params });
  return responses.at(-1)!;
};

let stone: string;
let tree: string;

beforeEach(async () => {
  useApp.setState(createAppState(), true);
  useAgentActivity.setState({ lastCall: {} }, true);
  responses.length = 0;
  stone = useApp.getState().activeDocId;
  // The user's own actions do not go through the bridge and leave no trace.
  tree = ((await execute('document.new', { name: 'Tree', activate: false })) as { id: string }).id;
  await execute('scene.add_primitive', { type: 'cube' });
  expect(active()).toEqual([]);
});

describe('MCP calls and the activity per document', () => {
  it('notes the targeted document, not the visible one', async () => {
    const response = await call('scene.add_primitive', { type: 'cube', name: 'Trunk', documentId: tree });
    expect(response.ok).toBe(true);
    expect(useApp.getState().docs[tree].state.order).toHaveLength(1);
    expect(active()).toEqual([tree]);
    expect(useApp.getState().activeDocId).toBe(stone);
  });

  it('notes the visible document for calls without documentId', async () => {
    await call('scene.add_primitive', { type: 'cube' });
    expect(active()).toEqual([stone]);
  });

  it('notes a document an MCP client creates, also in the background', async () => {
    const response = await call('document.new', { name: 'Bush', activate: false });
    const id = (response.result as { id: string }).id;
    expect(response.result).toMatchObject({ name: 'Bush', active: false });
    expect(active()).toEqual([id]);
    expect(useApp.getState().activeDocId).toBe(stone);
  });

  it('notes nothing for calls that are not about one document, and for a document that is not open', async () => {
    await call('document.list', {});
    await call('app.get_state', {});
    await call('preferences.get', {});
    expect((await call('scene.add_primitive', { type: 'cube', documentId: 'nope' })).error).toContain('does not exist');
    expect(active()).toEqual([]);
    expect((await call('app.get_state', { documentId: tree })).ok).toBe(true);
    expect(active()).toEqual([tree]);
  });

  it('notes a failed call as well, and a call that closes its document', async () => {
    expect((await call('scene.delete', { ids: ['missing'], documentId: tree })).ok).toBe(false);
    expect(active()).toEqual([tree]);
    const at = useAgentActivity.getState().lastCall[tree];
    await call('document.close', { documentId: tree });
    // Noted when the call started; not again once the document is gone.
    expect(useAgentActivity.getState().lastCall[tree]).toBeGreaterThanOrEqual(at);
    expect(useApp.getState().docs[tree]).toBeUndefined();
  });
});
