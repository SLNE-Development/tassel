import { z } from 'zod';
import { defineCommand, type AnyCommand } from './registry';

/** Upper limit for one validation call; a batch file of 16 MB cannot hold more commands than this. */
export const MAX_VALIDATED_COMMANDS = 100_000;

/**
 * app.validate_commands: checks the parameters of commands against their schemas without running
 * anything. Takes the registry as a function because the registry (index.ts) contains this command.
 */
export function createValidateCommands(all: () => readonly AnyCommand[]) {
  let byName: Map<string, AnyCommand> | null = null;
  const lookup = (name: string): AnyCommand | undefined => {
    if (!byName) {
      byName = new Map();
      // The MCP tool name (dots as underscores) is accepted as well as the command id.
      for (const def of all()) byName.set(def.id.replaceAll('.', '_'), def);
      for (const def of all()) byName.set(def.id, def);
    }
    return byName.get(name);
  };

  return [
    defineCommand({
      id: 'app.validate_commands',
      title: 'Befehle prüfen',
      description:
        'Check commands without running them: for every entry the params are parsed with the schema of that command (types, required fields, value ranges, enum values), exactly as a real call would do first. Nothing is executed and nothing changes, so what only shows at run time is NOT checked: whether ids / names exist, whether the command makes sense in the current mode. "command" is the dotted command id (e.g. "scene.add_primitive"; the tool name "scene_add_primitive" works too). A top-level "documentId" inside params is allowed and not checked. Returns { valid, errors: [{ index, message }] }: index is the 0-based position in "commands"; an unknown command is an error for its index; valid is true when there are no errors. Not an undo step.',
      params: z.object({
        commands: z
          .array(z.object({ command: z.string(), params: z.unknown().optional() }))
          .max(MAX_VALIDATED_COMMANDS)
          .describe('The commands to check, in order.'),
      }),
      history: false,
      run(_ctx, p) {
        const errors: { index: number; message: string }[] = [];
        p.commands.forEach(({ command, params }, index) => {
          const def = lookup(command);
          if (!def) {
            const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
            errors.push({ index, message: `Unknown command "${shown}"` });
            return;
          }
          let input: unknown = params ?? {};
          if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            errors.push({ index, message: `${def.id}: params must be an object` });
            return;
          }
          if ('documentId' in input && !('documentId' in def.params.shape)) {
            const { documentId, ...rest } = input as Record<string, unknown>;
            if (documentId !== undefined && typeof documentId !== 'string') {
              errors.push({ index, message: `${def.id}: documentId must be a string` });
              return;
            }
            input = rest;
          }
          const parsed = def.params.safeParse(input);
          if (!parsed.success) errors.push({ index, message: `${def.id}: invalid parameters:\n${z.prettifyError(parsed.error)}` });
        });
        return { valid: errors.length === 0, errors };
      },
    }),
  ];
}
