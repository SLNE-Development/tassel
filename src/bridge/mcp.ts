import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { z } from 'zod';
import { execute } from '../app/store';
import { commands } from '../core/commands';

export interface McpStatus {
  running: boolean;
  url: string;
  error: string | null;
}

/** One entry of the manifest sent to the backend with `mcp_register_commands`. */
interface CommandManifestEntry {
  /** MCP tool name: the command id with dots replaced by underscores. */
  name: string;
  /** Command id as understood by `execute`. */
  id: string;
  description: string;
  inputSchema: unknown;
}

/** Payload of the `mcp://call` event the backend emits for every tool call. */
interface McpCall {
  requestId: string;
  command: string;
  params: unknown;
}

const CALL_EVENT = 'mcp://call';

function buildManifest(): CommandManifestEntry[] {
  return commands.map((def) => ({
    name: def.id.replaceAll('.', '_'),
    id: def.id,
    description: def.description,
    // io: 'input' describes what callers send, so fields with defaults are not required.
    inputSchema: z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }),
  }));
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return `Invalid parameters:\n${z.prettifyError(error)}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function handleCall({ requestId, command, params }: McpCall): Promise<void> {
  let response: { requestId: string; ok: boolean; result: unknown; error: string | null };
  try {
    const result = await execute(command, params ?? {});
    response = { requestId, ok: true, result: result ?? null, error: null };
  } catch (error) {
    response = { requestId, ok: false, result: null, error: errorMessage(error) };
  }
  try {
    await invoke('mcp_respond', response);
  } catch (error) {
    // The request timed out on the backend or the result could not be serialized.
    console.warn(`MCP: could not deliver the result of ${command}`, error);
  }
}

let started: Promise<void> | null = null;

async function start(): Promise<void> {
  // Listen before registering: the backend only forwards calls once commands are registered.
  await listen<McpCall>(CALL_EVENT, (event) => {
    void handleCall(event.payload);
  });
  await invoke('mcp_register_commands', { commands: buildManifest() });
}

/** Connects the command registry to the MCP server in the Tauri backend. No-op outside Tauri. */
export async function startMcpBridge(): Promise<void> {
  if (!isTauri()) return;
  // Only ever start once, however often this is called (React strict mode, hot reload of callers).
  started ??= start().catch((error: unknown) => {
    started = null;
    throw error;
  });
  return started;
}

/** MCP server status, or null when not running inside Tauri. */
export async function getMcpStatus(): Promise<McpStatus | null> {
  if (!isTauri()) return null;
  return invoke<McpStatus>('mcp_status');
}
