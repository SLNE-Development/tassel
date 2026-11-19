import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { z } from 'zod';
import { noteAgentActivity } from '../app/agentActivity';
import { execute, useApp } from '../app/store';
import { commands, commandsById } from '../core/commands';
import { documentIdDescription, documentTargeting } from '../core/commands/targeting';
import { formatNote } from '../core/formats';
import { own } from '../core/state';
import type { AppState } from '../core/types';

export interface McpStatus {
  running: boolean;
  url: string;
  /** Access token MCP clients must send as `Authorization: Bearer <token>`. */
  token: string;
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

/** The command's input schema plus the optional `documentId` every tool call may carry (see `splitDocumentId`). */
function inputSchema(def: (typeof commands)[number]): unknown {
  // io: 'input' describes what callers send, so fields with defaults are not required.
  const schema = z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  if (Object.hasOwn(properties, 'documentId')) return schema;
  return { ...schema, properties: { ...properties, documentId: { type: 'string', description: documentIdDescription(def.id) } } };
}

export function buildManifest(): CommandManifestEntry[] {
  return commands.map((def) => ({
    name: def.id.replaceAll('.', '_'),
    id: def.id,
    // Commands that only work in some document formats say so first.
    description: formatNote(def.id, def.formats) + def.description,
    inputSchema: inputSchema(def),
  }));
}

/**
 * Takes the per-call `documentId` out of the params of a tool call: it is not a parameter of the
 * command but says which open document the command runs against (`execute`'s option). A command that
 * has a parameter of that name of its own keeps it.
 */
export function splitDocumentId(command: string, params: unknown): { params: unknown; documentId?: string } {
  if (typeof params !== 'object' || params === null || Array.isArray(params) || !Object.hasOwn(params, 'documentId')) return { params };
  const def = commandsById.get(command);
  if (def && 'documentId' in def.params.shape) return { params };
  const { documentId, ...rest } = params as Record<string, unknown>;
  if (documentId === undefined || documentId === null) return { params: rest };
  if (typeof documentId !== 'string') throw new Error('documentId must be a string: the id of an open document (see document_list)');
  return { params: rest, documentId };
}

/**
 * The open document a tool call works in, for the activity indicator on its tab; null for calls that are
 * not about one document (listing documents, preferences, ...). `params` and `documentId` as `splitDocumentId` returns them.
 */
export function workedDocument(app: AppState, command: string, params: unknown, documentId?: string): string | null {
  const given = (key: string): string | undefined => {
    const value = typeof params === 'object' && params !== null && Object.hasOwn(params, key) ? (params as Record<string, unknown>)[key] : undefined;
    return typeof value === 'string' ? value : undefined;
  };
  let id: string | undefined;
  switch (documentTargeting(command)) {
    case 'ignored':
      return null;
    case 'as-param':
      // Looking around without naming a document is not working in one.
      id = given('documentId');
      break;
    case 'as-id':
      id = given('id') ?? documentId ?? app.activeDocId;
      break;
    default:
      id = documentId ?? app.activeDocId;
  }
  return id !== undefined && own(app.docs, id) ? id : null;
}

/** Commands that return the document they added as `id`. */
const OPENING_COMMANDS = new Set(['document.new', 'document.load', 'document.import_java']);

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return `Invalid parameters:\n${z.prettifyError(error)}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Runs one tool call of an MCP client and sends its result back. Exported for tests. */
export async function handleCall({ requestId, command, params }: McpCall): Promise<void> {
  let response: { requestId: string; ok: boolean; result: unknown; error: string | null };
  try {
    const call = splitDocumentId(command, params ?? {});
    // Shown on that document's tab, from the start of the call (it may take a while) to a few seconds after its end.
    const worked = workedDocument(useApp.getState(), command, call.params, call.documentId);
    if (worked) noteAgentActivity(worked);
    const result = await execute(command, call.params, call.documentId === undefined ? undefined : { documentId: call.documentId });
    const opened = OPENING_COMMANDS.has(command) ? (result as { id?: unknown } | null)?.id : undefined;
    if (typeof opened === 'string') noteAgentActivity(opened);
    else if (worked && own(useApp.getState().docs, worked)) noteAgentActivity(worked);
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
