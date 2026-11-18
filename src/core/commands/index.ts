import { documentCommands } from './document';
import type { AnyCommand } from './registry';
import { sceneCommands } from './scene';
import { viewCommands } from './view';

export const commands: readonly AnyCommand[] = [...viewCommands, ...documentCommands, ...sceneCommands];

export const commandsById: ReadonlyMap<string, AnyCommand> = new Map(commands.map((c) => [c.id, c]));
