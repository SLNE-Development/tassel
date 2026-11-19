import { animCommands } from './anim';
import { animPoseCommands } from './animPose';
import { bakeCommands } from './bake';
import { cuboidCommands } from './cuboid';
import { displayCommands } from './display';
import { documentCommands } from './document';
import { factoryCommands } from './factory';
import { fileCommands } from './files';
import { fontCommands } from './font';
import { groupCommands } from './group';
import { itemCommands } from './item';
import { libraryCommands } from './library';
import { materialCommands } from './material';
import { minecraftCommands } from './minecraft';
import { minecraftParentCommands } from './minecraftParents';
import { modelImportCommands } from './modelImport';
import { meshCommands } from './mesh';
import { modifierCommands } from './modifier';
import { paintCommands } from './paint';
import { pixelPaintCommands } from './pixelPaint';
import { preferencesCommands } from './preferences';
import { previewCommands } from './preview';
import type { AnyCommand } from './registry';
import { renderCommands } from './render';
import { sceneCommands } from './scene';
import { sceneOpsCommands } from './sceneOps';
import { shapeCommands } from './shapes';
import { textureCommands } from './texture';
import { uvCommands } from './uv';
import { createValidateCommands } from './validate';
import { videoCommands } from './video';
import { viewCommands } from './view';

export const commands: readonly AnyCommand[] = [
  ...viewCommands,
  ...previewCommands,
  ...documentCommands,
  ...fileCommands,
  ...sceneCommands,
  ...sceneOpsCommands,
  ...shapeCommands,
  ...cuboidCommands,
  ...minecraftCommands,
  ...minecraftParentCommands,
  ...modelImportCommands,
  ...factoryCommands,
  ...displayCommands,
  ...itemCommands,
  ...fontCommands,
  ...groupCommands,
  ...materialCommands,
  ...textureCommands,
  ...libraryCommands,
  ...paintCommands,
  ...pixelPaintCommands,
  ...meshCommands,
  ...uvCommands,
  ...modifierCommands,
  ...preferencesCommands,
  ...bakeCommands,
  ...renderCommands,
  ...animCommands,
  ...animPoseCommands,
  ...videoCommands,
  ...createValidateCommands(() => commands),
];

export const commandsById: ReadonlyMap<string, AnyCommand> = new Map(commands.map((c) => [c.id, c]));
