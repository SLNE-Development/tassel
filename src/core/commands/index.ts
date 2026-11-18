import { bakeCommands } from './bake';
import { documentCommands } from './document';
import { fileCommands } from './files';
import { groupCommands } from './group';
import { materialCommands } from './material';
import { meshCommands } from './mesh';
import { modifierCommands } from './modifier';
import { paintCommands } from './paint';
import { preferencesCommands } from './preferences';
import type { AnyCommand } from './registry';
import { sceneCommands } from './scene';
import { textureCommands } from './texture';
import { uvCommands } from './uv';
import { viewCommands } from './view';

export const commands: readonly AnyCommand[] = [
  ...viewCommands,
  ...documentCommands,
  ...fileCommands,
  ...sceneCommands,
  ...groupCommands,
  ...materialCommands,
  ...textureCommands,
  ...paintCommands,
  ...meshCommands,
  ...uvCommands,
  ...modifierCommands,
  ...preferencesCommands,
  ...bakeCommands,
];

export const commandsById: ReadonlyMap<string, AnyCommand> = new Map(commands.map((c) => [c.id, c]));
