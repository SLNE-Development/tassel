// UV commands (uv.*): unwrap, pack, transform, clear and query the texture coordinates of an object.
import { z } from 'zod';
import { selectedFaces } from '../mesh/selection';
import { clearUvs, packUvs, transformUvs, unwrap, unwrapMethods, uvCharts } from '../mesh/uv';
import type { DocState, PolyMesh, SceneObject } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

const objectId = z.string().optional().describe('Object id. Defaults to the active object.');
const uv = z.tuple([z.number(), z.number()]);
const margin = z
  .number()
  .min(0)
  .max(0.25)
  .default(0.02)
  .describe('Gap between charts and to the border, as a fraction of the texture (0.02 = 2 %). Shrinks automatically if there are too many charts for it.');

const scope =
  'Works in object mode and in edit mode; in edit mode on the object being edited it acts on the selected faces only ' +
  '(in vertex / edge mode: faces whose vertices are all selected), or on all faces if none is selected.';

/** The object to work on and the faces the command is limited to (null = all faces). */
function target(state: DocState, id: string | undefined): { object: SceneObject; faces: number[] | null } {
  const resolved = id ?? state.activeId;
  if (!resolved) throw new Error('No objectId given and there is no active object');
  const object = state.objects[resolved];
  if (!object) throw new Error(`Object "${resolved}" does not exist`);
  const selected = state.edit?.objectId === resolved ? selectedFaces(object.mesh, state.edit) : [];
  return { object, faces: selected.length > 0 ? selected : null };
}

function requireUvs(object: SceneObject, command: string): void {
  if (!object.mesh.uvs) throw new Error(`${command}: "${object.name}" has no UVs yet. Create them with uv.unwrap first.`);
}

function setMesh(ctx: CommandContext, id: string, mesh: PolyMesh): void {
  updateDocState(ctx, (s) => ({ ...s, objects: { ...s.objects, [id]: { ...s.objects[id], mesh } } }));
}

export const uvCommands = [
  defineCommand({
    id: 'uv.unwrap',
    title: 'UV abwickeln',
    description:
      'Create texture coordinates (UVs) for an object, so that a material with texture maps can be shown on it. UVs are stored per face corner in the 0..1 square, v up. ' +
      "`method`: 'smart' (default, works for any shape) cuts the surface into charts of faces that point roughly the same way " +
      '(a chart grows over neighbouring faces while their normal is within `angle` degrees of the face it started from; smaller angle = more charts with less distortion), ' +
      'projects every chart flat and packs all charts into 0..1 without overlap, all at the same texel density, with `margin` between them. ' +
      "'box' projects every face along the axis it faces most (six directions) and packs the pieces the same way; good for boxy, architectural shapes. " +
      "'planar' projects all faces along `axis` like a slide projector (faces on the far side get the same, mirrored image; the proportions are kept and the longer side fills 0..1). " +
      "'cylinder' wraps the texture once around `axis` (u around, v along the axis; flat caps are projected into the full square); " +
      "'sphere' does the same with v as latitude. The seam of both is at the back; faces crossing it continue slightly past u = 0 or 1, which needs a repeating texture. " +
      '`axis` defaults to y and only applies to planar / cylinder / sphere, `angle` and `margin` only to smart / box. ' +
      `${scope} Faces left out keep their UVs (or get 0,0 if the object had none), and smart / box pack only the unwrapped faces, which may then overlap the others. ` +
      'UVs belong to the base mesh; modifiers carry them along (boolean results have none), and mesh operations that change the topology remove them, so unwrap after modelling. ' +
      'Returns { charts, coverage }: the number of UV islands and the share of the texture area they use.',
    params: z.object({
      objectId,
      method: z.enum(unwrapMethods).default('smart'),
      angle: z.number().min(0).max(89).default(66).describe('smart: maximum angle in degrees between face normals within one chart.'),
      margin,
      axis: z.enum(['x', 'y', 'z']).optional().describe('planar: projection direction; cylinder / sphere: the axis to wrap around. Default y.'),
    }),
    run(ctx, p) {
      const { object, faces } = target(docState(ctx), p.objectId);
      if (object.mesh.faces.length === 0) throw new Error(`uv.unwrap: "${object.name}" has no faces`);
      const result = unwrap(object.mesh, { method: p.method, angle: p.angle, margin: p.margin, axis: p.axis, faces });
      setMesh(ctx, object.id, result.mesh);
      return { charts: result.charts, coverage: result.coverage };
    },
  }),

  defineCommand({
    id: 'uv.clear',
    title: 'UVs entfernen',
    description:
      'Remove the texture coordinates of an object (always of the whole mesh, also in edit mode). Texture maps of its material are then not shown on it. ' +
      'Returns { hadUvs }; does nothing if the object has no UVs.',
    params: z.object({ objectId }),
    run(ctx, p) {
      const { object } = target(docState(ctx), p.objectId);
      if (!object.mesh.uvs) return { hadUvs: false };
      setMesh(ctx, object.id, clearUvs(object.mesh));
      return { hadUvs: true };
    },
  }),

  defineCommand({
    id: 'uv.transform',
    title: 'UVs transformieren',
    description:
      'Move, rotate and/or scale texture coordinates in UV space. Applied in the order scale, rotate, translate. ' +
      '`translate` is an offset [u, v] (1 = the whole texture), `rotate` an angle in degrees (counter-clockwise), `scale` a factor or [u, v] factors ' +
      '(scale 2 makes the faces cover twice as much of the texture, i.e. the image appears half as large on the surface). ' +
      'Rotation and scaling happen about `pivot`, which defaults to the centre of the bounding box of the affected UVs. ' +
      `${scope} Select the faces of one chart (see uv.get) to move a single chart. The object needs UVs (uv.unwrap).`,
    params: z.object({
      objectId,
      translate: uv.optional(),
      rotate: z.number().optional().describe('Degrees, counter-clockwise.'),
      scale: z.union([uv, z.number()]).optional(),
      pivot: uv.optional().describe('UV-space centre for rotate and scale. Defaults to the centre of the affected UVs.'),
    }),
    run(ctx, p) {
      const { object, faces } = target(docState(ctx), p.objectId);
      if (!p.translate && p.rotate === undefined && p.scale === undefined) throw new Error('Give at least one of translate, rotate or scale');
      requireUvs(object, 'uv.transform');
      setMesh(ctx, object.id, transformUvs(object.mesh, faces, p));
      return { faces: faces ? faces.length : object.mesh.faces.length };
    },
  }),

  defineCommand({
    id: 'uv.pack',
    title: 'UVs packen',
    description:
      'Re-pack the existing UV charts into the 0..1 square without overlap. A chart is a connected UV island: faces that share an edge with the same UVs on both sides. ' +
      'Every chart is rescaled to the same texel density (UV area per surface area), may be rotated to save space, and gets `margin` distance to the others and to the border. ' +
      'Use it after uv.transform or after mesh.delete / mesh.merge left gaps; the shape of the charts does not change. ' +
      `${scope} The object needs UVs (uv.unwrap). Returns { charts, coverage }.`,
    params: z.object({ objectId, margin }),
    run(ctx, p) {
      const { object, faces } = target(docState(ctx), p.objectId);
      requireUvs(object, 'uv.pack');
      const result = packUvs(object.mesh, p.margin, faces);
      setMesh(ctx, object.id, result.mesh);
      return { charts: result.charts, coverage: result.coverage };
    },
  }),

  defineCommand({
    id: 'uv.get',
    title: 'UVs abfragen',
    description:
      'Read the texture coordinates of an object. Returns { hasUvs, charts, total, faces }: `charts` is the number of UV islands of the whole mesh, ' +
      '`faces` lists { index, chart, uvs } with `uvs` as flat [u0, v0, u1, v1, …] for the corners of the face in the order of its vertices (see mesh.get_elements) ' +
      'and `chart` the number of the island the face belongs to. `total` is the number of faces listed in full; page with offset / limit. ' +
      'In edit mode on the edited object only the selected faces are listed (all if none is selected). Without UVs: { hasUvs: false, charts: 0, total: 0, faces: [] }. Changes nothing.',
    params: z.object({
      objectId,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(5000).default(200),
    }),
    history: false,
    run(ctx, p) {
      const { object, faces } = target(docState(ctx), p.objectId);
      const uvs = object.mesh.uvs;
      if (!uvs) return { hasUvs: false, charts: 0, total: 0, faces: [] };
      const charts = uvCharts(object.mesh);
      const chartOf = new Map<number, number>();
      charts.forEach((chart, i) => chart.forEach((f) => chartOf.set(f, i)));
      const list = faces ?? uvs.map((_, i) => i);
      return {
        hasUvs: true,
        charts: charts.length,
        total: list.length,
        faces: list.slice(p.offset, p.offset + p.limit).map((f) => ({ index: f, chart: chartOf.get(f)!, uvs: uvs[f] })),
      };
    },
  }),
];
