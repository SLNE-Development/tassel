import { create } from 'zustand';

/** How long after its last tool call a document still shows that an AI client is working in it. */
export const AGENT_ACTIVITY_MS = 4000;

interface AgentActivity {
  /** Per document id: when (`Date.now()`) an MCP client last ran a command against it. Older than `AGENT_ACTIVITY_MS` = not listed. */
  readonly lastCall: Readonly<Record<string, number>>;
}

/**
 * Where AI clients are working right now, for the indicator on the document tabs. A store of its own,
 * apart from the editor state: a tool call must not make the viewport or the panels look at anything.
 */
export const useAgentActivity = create<AgentActivity>(() => ({ lastCall: {} }));

/** Notes that an MCP client just ran (or started) a command against this document. */
export function noteAgentActivity(documentId: string, now: number = Date.now()): void {
  useAgentActivity.setState(({ lastCall }) => {
    const next: Record<string, number> = {};
    // Entries that have faded are dropped, so the record never grows beyond the documents in use.
    for (const id of Object.keys(lastCall)) if (now - lastCall[id] < AGENT_ACTIVITY_MS) next[id] = lastCall[id];
    next[documentId] = now;
    return { lastCall: next };
  }, true);
}

/** For how many milliseconds from `now` a call noted at `last` still counts; 0 when it has faded. */
export function agentActivityLeft(last: number | undefined, now: number = Date.now()): number {
  return last === undefined ? 0 : Math.max(0, last + AGENT_ACTIVITY_MS - now);
}
