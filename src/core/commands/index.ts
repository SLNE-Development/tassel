import { documentCommands } from './document';
import { meshCommands } from './mesh';
import { modifierCommands } from './modifier';
import type { AnyCommand } from './registry';
import { sceneCommands } from './scene';
import { viewCommands } from './view';

export const commands: readonly AnyCommand[] = [
  ...viewCommands,
  ...documentCommands,
  ...sceneCommands,
  ...meshCommands,
  ...modifierCommands,
];

export const commandsById: ReadonlyMap<string, AnyCommand> = new Map(commands.map((c) => [c.id, c]));
