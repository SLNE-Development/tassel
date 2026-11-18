import { z } from 'zod';
import { activeDoc } from '../state';
import { shadings, tools, viewPresets, workspaces } from '../types';
import { defineCommand, docState, vec3, type CommandContext } from './registry';

function viewport(ctx: CommandContext) {
  if (!ctx.services.viewport) throw new Error('The 3D viewport is not ready yet');
  return ctx.services.viewport;
}

export const viewCommands = [
  defineCommand({
    id: 'app.get_state',
    title: 'Editor-Zustand abfragen',
    description:
      'Get the current editor state: open documents, active document, workspace, tool, shading, selection and camera. Call this first to find out where you are.',
    params: z.object({}),
    run(ctx) {
      const app = ctx.get();
      const doc = activeDoc(app);
      return {
        activeDocument: { id: doc.id, name: doc.name, filePath: doc.filePath, dirty: doc.dirty },
        documents: app.docOrder.map((id) => ({ id, name: app.docs[id].name })),
        workspace: app.workspace,
        tool: app.tool,
        shading: app.shading,
        objectCount: doc.state.order.length,
        selection: doc.state.selection,
        activeObjectId: doc.state.activeId,
        canUndo: doc.past.length > 0,
        canRedo: doc.future.length > 0,
        camera: ctx.services.viewport?.getCamera() ?? null,
      };
    },
  }),

  defineCommand({
    id: 'app.set_workspace',
    title: 'Arbeitsbereich wechseln',
    description: 'Switch the workspace tab: modeling, uv or paint.',
    params: z.object({ workspace: z.enum(workspaces) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, workspace: p.workspace }));
    },
  }),

  defineCommand({
    id: 'view.set_tool',
    title: 'Werkzeug wählen',
    description: 'Set the active viewport tool: select, move, rotate or scale.',
    params: z.object({ tool: z.enum(tools) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, tool: p.tool }));
    },
  }),

  defineCommand({
    id: 'view.set_shading',
    title: 'Darstellung wechseln',
    description: 'Set the viewport shading: solid, wireframe or material.',
    params: z.object({ shading: z.enum(shadings) }),
    run(ctx, p) {
      ctx.set((app) => ({ ...app, shading: p.shading }));
    },
  }),

  defineCommand({
    id: 'view.screenshot',
    title: 'Screenshot',
    description:
      'Render the viewport of the active document to a PNG image so you can see the result of your work. view "current" uses the user\'s camera; a preset (front, back, left, right, top, bottom, iso) renders from that direction with everything in frame, without moving the user\'s camera.',
    params: z.object({
      width: z.number().int().min(64).max(4096).default(1024),
      height: z.number().int().min(64).max(4096).default(768),
      view: z.enum(['current', ...viewPresets]).default('current'),
      fit: z.boolean().default(false).describe('Fit all visible objects into the frame'),
    }),
    async run(ctx, p) {
      const base64 = await viewport(ctx).screenshot(p);
      return { image: { mimeType: 'image/png', base64 } };
    },
  }),

  defineCommand({
    id: 'view.get_camera',
    title: 'Kamera abfragen',
    description: 'Get the viewport camera position and orbit target.',
    params: z.object({}),
    run(ctx) {
      return viewport(ctx).getCamera();
    },
  }),

  defineCommand({
    id: 'view.set_camera',
    title: 'Kamera setzen',
    description: 'Move the viewport camera. position and target are world coordinates (Y is up).',
    params: z.object({ position: vec3.optional(), target: vec3.optional() }),
    run(ctx, p) {
      viewport(ctx).setCamera(p);
      return viewport(ctx).getCamera();
    },
  }),

  defineCommand({
    id: 'view.set_view',
    title: 'Ansicht wählen',
    description: 'Look at the scene from a preset direction: front, back, left, right, top, bottom or iso.',
    params: z.object({ preset: z.enum(viewPresets) }),
    run(ctx, p) {
      viewport(ctx).setView(p.preset);
    },
  }),

  defineCommand({
    id: 'view.frame',
    title: 'Auswahl fokussieren',
    description: 'Frame the given objects in the viewport. Defaults to the selection, or everything if nothing is selected.',
    params: z.object({ ids: z.array(z.string()).optional() }),
    run(ctx, p) {
      viewport(ctx).frame(p.ids ?? docState(ctx).selection);
    },
  }),

  defineCommand({
    id: 'export.gltf',
    title: 'Als glTF exportieren',
    description:
      'Export the active document as glTF and return the data (GLB as base64, or glTF JSON text). Usually you want the file_export tool instead, which writes the file to disk.',
    params: z.object({
      binary: z.boolean().default(true).describe('true = GLB, false = glTF JSON'),
      selectionOnly: z.boolean().default(false),
    }),
    async run(ctx, p) {
      if (!ctx.services.exporter) throw new Error('The exporter is not ready yet');
      const state = docState(ctx);
      if (p.selectionOnly && state.selection.length === 0) throw new Error('Nothing is selected');
      const data = await ctx.services.exporter.gltf(state, {
        binary: p.binary,
        ids: p.selectionOnly ? state.selection : undefined,
      });
      return p.binary ? { format: 'glb', base64: data } : { format: 'gltf', text: data };
    },
  }),
];
