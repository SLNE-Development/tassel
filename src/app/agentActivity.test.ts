import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ACTIVITY_MS, agentActivityLeft, noteAgentActivity, useAgentActivity } from './agentActivity';
import { useApp } from './store';

const lastCall = () => useAgentActivity.getState().lastCall;

beforeEach(() => {
  useAgentActivity.setState({ lastCall: {} }, true);
});

describe('agent activity', () => {
  it('remembers per document when a client last called', () => {
    noteAgentActivity('tree', 1000);
    noteAgentActivity('stone', 1500);
    expect(lastCall()).toEqual({ tree: 1000, stone: 1500 });
    noteAgentActivity('tree', 2000);
    expect(lastCall()).toEqual({ tree: 2000, stone: 1500 });
  });

  it('counts down from the last call and fades', () => {
    expect(agentActivityLeft(undefined, 5000)).toBe(0);
    expect(agentActivityLeft(1000, 1000)).toBe(AGENT_ACTIVITY_MS);
    expect(agentActivityLeft(1000, 1000 + AGENT_ACTIVITY_MS - 1)).toBe(1);
    expect(agentActivityLeft(1000, 1000 + AGENT_ACTIVITY_MS)).toBe(0);
    expect(agentActivityLeft(1000, 1_000_000)).toBe(0);
  });

  it('drops faded entries when the next call arrives, so the record does not grow', () => {
    noteAgentActivity('tree', 1000);
    noteAgentActivity('stone', 1000 + AGENT_ACTIVITY_MS - 1);
    expect(Object.keys(lastCall())).toEqual(['tree', 'stone']);
    noteAgentActivity('stone', 1000 + AGENT_ACTIVITY_MS);
    expect(lastCall()).toEqual({ stone: 1000 + AGENT_ACTIVITY_MS });
  });

  it('leaves the entry of an untouched document identical, so its tab does not render again', () => {
    noteAgentActivity('tree', 1000);
    const seen: (number | undefined)[] = [];
    const unsubscribe = useAgentActivity.subscribe((state, previous) => {
      if (state.lastCall.tree !== previous.lastCall.tree) seen.push(state.lastCall.tree);
    });
    noteAgentActivity('stone', 1200);
    noteAgentActivity('stone', 1400);
    unsubscribe();
    expect(seen).toEqual([]);
  });

  it('is not part of the editor state: noting a call does not notify its subscribers', () => {
    let notified = 0;
    const unsubscribe = useApp.subscribe(() => notified++);
    noteAgentActivity(useApp.getState().activeDocId);
    unsubscribe();
    expect(notified).toBe(0);
  });
});
