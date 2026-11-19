// Test helpers: an app with all commands, for the Minecraft tests.
import { commandsById } from '../commands';
import { MISSING_TEXTURE_PNG } from './javaImport';
import { runCommand, type CommandContext } from '../commands/registry';
import { activeDoc, createAppState } from '../state';
import type { AppState, DocState, Services } from '../types';

export interface TestApp {
  ctx: CommandContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(id: string, params?: unknown): Promise<any>;
  state(): DocState;
  app(): AppState;
}

export function testApp(services: Partial<Services> = {}): TestApp {
  let app = createAppState();
  const ctx: CommandContext = {
    get: () => app,
    set: (update) => {
      app = update(app);
    },
    services: { viewport: null, exporter: null, ...services },
  };
  return {
    ctx,
    run(id, params) {
      const def = commandsById.get(id);
      if (!def) throw new Error(`Unknown command ${id}`);
      return runCommand(def, ctx, params);
    },
    state: () => activeDoc(app).state,
    app: () => app,
  };
}

/** A test app whose active document is a new Minecraft Java document. */
export async function minecraftApp(params: Record<string, unknown> = {}, services: Partial<Services> = {}): Promise<TestApp> {
  const t = testApp(services);
  await t.run('document.new', { name: 'Test Block', format: 'minecraft_java', ...params });
  return t;
}

/** Adds a 16 x 16 PNG texture and returns its id. */
export async function addTexture(t: TestApp, name: string): Promise<string> {
  return (await t.run('texture.add', { name, mimeType: 'image/png', data: MISSING_TEXTURE_PNG, width: 16, height: 16 })).id;
}
