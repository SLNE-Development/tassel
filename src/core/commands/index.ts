import { documentCommands } from './document';
import { groupCommands } from './group';
import { meshCommands } from './mesh';
import { modifierCommands } from './modifier';
import { preferencesCommands } from './preferences';
import type { AnyCommand } from './registry';
import { sceneCommands } from './scene';
import { viewCommands } from './view';

export const commands: readonly AnyCommand[] = [
  ...viewCommands,
  ...documentCommands,
  ...sceneCommands,
  ...groupCommands,
  ...meshCommands,
  ...modifierCommands,
  ...preferencesCommands,
];

export const commandsById: ReadonlyMap<string, AnyCommand> = new Map(commands.map((c) => [c.id, c]));
