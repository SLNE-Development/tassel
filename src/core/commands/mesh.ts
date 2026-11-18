// Edit mode: mode switches (edit.*), element selection and mesh operations (mesh.*).
import { z } from 'zod';
import { bevelEdges } from '../mesh/ops/bevel';
import { deleteElements } from '../mesh/ops/delete';
import { extrudeFaces, insetFaces } from '../mesh/ops/extrude';
import { fillFace } from '../mesh/ops/fill';
import { flipFaces } from '../mesh/ops/flip';
import { edgeLoop, edgeRing, loopCut } from '../mesh/ops/loops';
import { mergeByDistance, mergeVertices } from '../mesh/ops/merge';
import { subdivideFaces } from '../mesh/ops/subdivide';
import { transformVertices } from '../mesh/ops/transform';
import type { MeshOpResult } from '../mesh/ops/types';
import { meshStats } from '../mesh/polymesh';
import {
  checkElements,
  combineSelection,
  convertSelection,
  invertSelection,
  listElements,
  makeSelection,
  selectAll,
  selectBy,
  selectedEdges,
  selectedFaces,
  selectedVertices,
  selectionFromElements,
  selectLess,
  selectLinked,
  selectMore,
  type MeshSelection,
} from '../mesh/selection';
import { activeDoc } from '../state';
import { elementModes, type DocState, type Edge, type EditState, type ElementMode, type PolyMesh } from '../types';
import { defineCommand, docState, updateDocState, vec3, type CommandContext } from './registry';

/** Element mode last used per document id. Not part of the document state: it is a UI preference, not undoable. */
const lastElementMode = new Map<string, ElementMode>();

const index = z.number().int().nonnegative();
const edgeParam = z.tuple([index, index]);
const actionParam = z
  .enum(['replace', 'add', 'remove', 'toggle'])
  .default('replace')
  .describe('How the result combines with the current selection: replace it, add to it, remove from it, or toggle each element.');

function requireEdit(state: DocState): { edit: EditState; mesh: PolyMesh } {
  if (!state.edit) throw new Error('Not in edit mode. Call edit.enter first (it edits the active object, or the object given as id).');
  return { edit: state.edit, mesh: state.objects[state.edit.objectId].mesh };
}

function selectionCount(sel: MeshSelection): number {
  return sel.elementMode === 'vertex' ? sel.vertices.length : sel.elementMode === 'edge' ? sel.edges.length : sel.faces.length;
}

function selectionResult(sel: MeshSelection) {
  return { elementMode: sel.elementMode, selected: selectionCount(sel) };
}

function setSelection(ctx: CommandContext, sel: MeshSelection) {
  updateDocState(ctx, (s) => (s.edit ? { ...s, edit: { ...s.edit, ...sel } } : s));
  return selectionResult(sel);
}

/** Selection commands that compute elements and combine them with the current selection. */
function select(ctx: CommandContext, elements: MeshSelection, action: z.infer<typeof actionParam>) {
  const { edit } = requireEdit(docState(ctx));
  const own = edit.elementMode === 'vertex' ? elements.vertices : edit.elementMode === 'edge' ? elements.edges : elements.faces;
  return setSelection(ctx, combineSelection(edit, own, action));
}

/**
 * Stores the result of a mesh operation: the new mesh and, in the same state update, the new
 * selection (so undo restores both). `keepSelection` is for operations that do not renumber elements.
 */
function applyOp(ctx: CommandContext, result: MeshOpResult, keepSelection = false) {
  const { edit } = requireEdit(docState(ctx));
  const sel: MeshSelection = keepSelection ? edit : selectionFromElements(result.mesh, edit.elementMode, result);
  updateDocState(ctx, (s) => ({
    ...s,
    objects: { ...s.objects, [edit.objectId]: { ...s.objects[edit.objectId], mesh: result.mesh } },
    edit: { ...edit, ...sel },
  }));
  return { ...meshStats(result.mesh), ...selectionResult(sel) };
}

/** The selection as faces, or an error naming the command that needs them. */
function requireFaces(mesh: PolyMesh, edit: EditState, command: string): number[] {
  const faces = selectedFaces(mesh, edit);
  if (faces.length === 0) {
    throw new Error(
      edit.elementMode === 'face'
        ? `${command} needs at least one selected face, but nothing is selected`
        : `${command} needs at least one selected face: in ${edit.elementMode} mode a face counts as selected when all its vertices are selected`,
    );
  }
  return faces;
}

function requireMeshEdge(mesh: PolyMesh, edge: Edge): Edge {
  return (checkElements(mesh, 'edge', [edge]) as Edge[])[0];
}

function enterEdit(ctx: CommandContext, objectId: string | undefined) {
  const state = docState(ctx);
  const id = objectId ?? state.activeId;
  if (!id) throw new Error('No object given and there is no active object to edit');
  const obj = state.objects[id];
  if (!obj) throw new Error(`Object "${id}" does not exist`);
  let edit = state.edit;
  if (edit?.objectId !== id) {
    const fresh: EditState = { objectId: id, ...makeSelection(lastElementMode.get(activeDoc(ctx.get()).id) ?? 'vertex', []) };
    edit = fresh;
    updateDocState(ctx, (s) => ({ ...s, selection: [id], activeId: id, edit: fresh }));
  }
  return { objectId: id, elementMode: edit.elementMode, ...meshStats(obj.mesh) };
}

const afterwards = 'Afterwards the selection is';
const needsEdit = 'Requires edit mode.';
const noUndo = 'Not an undo step.';

export const meshCommands = [
  // ---- Mode ------------------------------------------------------------------------------------

  defineCommand({
    id: 'edit.enter',
    title: 'Bearbeitungsmodus starten',
    description:
      'Enter edit mode to edit the vertices, edges and faces of one object (default: the active object). ' +
      'The object becomes the only selected object. Edit mode starts in the element mode last used in this document (initially vertex) with nothing selected. ' +
      'Element indices refer to the base mesh (before modifiers); inspect them with mesh.get_elements. ' +
      'Typical workflow: edit.enter, edit.set_element_mode, mesh.select_by / mesh.select, then an operation such as mesh.extrude, finally edit.exit.',
    params: z.object({ id: z.string().optional().describe('Object id. Defaults to the active object.') }),
    history: false,
    run: (ctx, p) => enterEdit(ctx, p.id),
  }),

  defineCommand({
    id: 'edit.exit',
    title: 'Bearbeitungsmodus beenden',
    description: 'Leave edit mode and return to object mode. The edited object stays selected. Does nothing in object mode.',
    params: z.object({}),
    history: false,
    run(ctx) {
      updateDocState(ctx, (s) => (s.edit ? { ...s, edit: null } : s));
    },
  }),

  defineCommand({
    id: 'edit.toggle',
    title: 'Bearbeitungsmodus umschalten',
    description: 'Switch between object mode and edit mode: enters edit mode for the active object, or leaves it. Returns the new mode.',
    params: z.object({}),
    history: false,
    run(ctx) {
      if (docState(ctx).edit) {
        updateDocState(ctx, (s) => ({ ...s, edit: null }));
        return { mode: 'object' };
      }
      return { mode: 'edit', ...enterEdit(ctx, undefined) };
    },
  }),

  defineCommand({
    id: 'edit.set_element_mode',
    title: 'Elementmodus setzen',
    description:
      'Choose whether vertices, edges or faces are selected and edited. The current selection is converted: ' +
      'to vertices = all vertices of the selected edges / faces; to edges or faces = every edge / face whose vertices are all selected ' +
      '(so one selected face becomes its 4 vertices, but 2 selected vertices of a quad do not select the quad). ' +
      `${needsEdit} Returns the number of selected elements in the new mode.`,
    params: z.object({ mode: z.enum(elementModes) }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      lastElementMode.set(activeDoc(ctx.get()).id, p.mode);
      return setSelection(ctx, convertSelection(mesh, edit, p.mode));
    },
  }),

  // ---- Selection -------------------------------------------------------------------------------

  defineCommand({
    id: 'mesh.select',
    title: 'Elemente auswählen',
    description:
      'Select elements of the current element mode by index: pass `indices` in vertex or face mode, `edges` (vertex index pairs) in edge mode. ' +
      'Indices come from mesh.get_elements. The order is remembered: mesh.merge can merge at the first or last selected vertex. ' +
      `To select by direction or region without knowing indices use mesh.select_by. ${needsEdit} ${noUndo}`,
    params: z.object({
      indices: z.array(index).optional().describe('Vertex indices (vertex mode) or face indices (face mode).'),
      edges: z.array(edgeParam).optional().describe('Edges as [vertexA, vertexB] pairs (edge mode).'),
      action: actionParam,
    }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const mode = edit.elementMode;
      const given = mode === 'edge' ? p.edges : p.indices;
      if (!given || (mode === 'edge' ? p.indices : p.edges)) {
        throw new Error(
          mode === 'edge'
            ? 'The element mode is edge: pass `edges` as [vertexA, vertexB] pairs (or switch with edit.set_element_mode)'
            : `The element mode is ${mode}: pass \`indices\` (or switch with edit.set_element_mode)`,
        );
      }
      return setSelection(ctx, combineSelection(edit, checkElements(mesh, mode, given), p.action));
    },
  }),

  defineCommand({
    id: 'mesh.select_all',
    title: 'Alle Elemente auswählen',
    description: `Select all elements (of the current element mode) of the edited mesh. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return setSelection(ctx, selectAll(mesh, edit.elementMode));
    },
  }),

  defineCommand({
    id: 'mesh.select_none',
    title: 'Elementauswahl aufheben',
    description: `Deselect all elements of the edited mesh. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit } = requireEdit(docState(ctx));
      return setSelection(ctx, makeSelection(edit.elementMode, []));
    },
  }),

  defineCommand({
    id: 'mesh.select_invert',
    title: 'Elementauswahl umkehren',
    description: `Invert the element selection: selected elements become unselected and vice versa. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return setSelection(ctx, invertSelection(mesh, edit));
    },
  }),

  defineCommand({
    id: 'mesh.select_linked',
    title: 'Verbundene auswählen',
    description:
      `Grow the selection to everything connected to it, i.e. the whole mesh island(s) the selected elements belong to. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return setSelection(ctx, selectLinked(mesh, edit));
    },
  }),

  defineCommand({
    id: 'mesh.select_more',
    title: 'Auswahl erweitern',
    description:
      `Grow the selection by one ring: everything belonging to a face that touches the selection becomes selected. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return setSelection(ctx, selectMore(mesh, edit));
    },
  }),

  defineCommand({
    id: 'mesh.select_less',
    title: 'Auswahl verkleinern',
    description:
      `Shrink the selection by one ring: elements on the border of the selected area (touching a face that is not fully selected) are deselected. ${needsEdit} ${noUndo}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return setSelection(ctx, selectLess(mesh, edit));
    },
  }),

  defineCommand({
    id: 'mesh.select_loop',
    title: 'Kantenschleife auswählen',
    description:
      'Select the edge loop through an edge: the chain of edges that continues straight on across vertices where four edges meet ' +
      '(e.g. one circle around a cylinder or sphere). `edge` is a [vertexA, vertexB] pair of an existing edge. ' +
      'In vertex mode the vertices of the loop are selected; in face mode only faces whose vertices all lie on the loop (use mesh.select_ring for a band of faces). ' +
      `${needsEdit} ${noUndo}`,
    params: z.object({ edge: edgeParam, action: actionParam }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const edges = edgeLoop(mesh, requireMeshEdge(mesh, p.edge));
      return select(ctx, selectionFromElements(mesh, edit.elementMode, { edges }), p.action);
    },
  }),

  defineCommand({
    id: 'mesh.select_ring',
    title: 'Kantenring auswählen',
    description:
      'Select the edge ring through an edge: the parallel edges on opposite sides of consecutive quads (the rungs of a ladder). ' +
      '`edge` is a [vertexA, vertexB] pair of an existing edge. In vertex mode the vertices of these edges are selected; ' +
      `in face mode the band of quads between them (a face loop). ${needsEdit} ${noUndo}`,
    params: z.object({ edge: edgeParam, action: actionParam }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const edges = edgeRing(mesh, requireMeshEdge(mesh, p.edge));
      return select(ctx, selectionFromElements(mesh, edit.elementMode, { edges }), p.action);
    },
  }),

  defineCommand({
    id: 'mesh.select_by',
    title: 'Nach Kriterien auswählen',
    description:
      'Select elements of the current element mode by geometric criteria, in the LOCAL space of the edited object (Y up; the object transform is ignored). ' +
      'Criteria are combined with AND; give at least one. ' +
      '`normal` + `angle`: faces whose normal is within `angle` degrees of that direction, e.g. normal [0,1,0] for everything facing up ' +
      '(in vertex / edge mode: the vertices / edges of those faces). ' +
      '`boxMin` / `boxMax`: elements whose centre (vertex position, edge midpoint, face centroid) lies inside the axis-aligned box; ' +
      'either corner may be omitted for a half-open region, e.g. boxMin [-100,0.9,-100] for everything with y >= 0.9. ' +
      `Returns how many elements are selected afterwards. ${needsEdit} ${noUndo}`,
    params: z.object({
      normal: vec3.optional().describe('Direction to compare face normals with (any length).'),
      angle: z.number().min(0).max(180).default(10).describe('Maximum deviation from `normal` in degrees.'),
      boxMin: vec3.optional(),
      boxMax: vec3.optional(),
      action: actionParam,
    }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      if (!p.normal && !p.boxMin && !p.boxMax) throw new Error('Give at least one criterion: normal, boxMin or boxMax');
      return select(ctx, selectBy(mesh, edit.elementMode, p), p.action);
    },
  }),

  defineCommand({
    id: 'mesh.get_elements',
    title: 'Elemente abfragen',
    description:
      'List vertices, edges or faces of the edited mesh (local space) with their selection state. ' +
      'Vertex: { index, position }. Edge: { vertices: [a, b], midpoint, length }. Face: { index, vertices, centroid, normal, area }. Each has `selected`. ' +
      '`kind` defaults to the current element mode; for another kind, `selected` follows the conversion rules of edit.set_element_mode. ' +
      '`total` is the number of matching elements; page through large meshes with offset / limit, or set selectedOnly to see just the selection. ' +
      `${needsEdit} Changes nothing.`,
    params: z.object({
      kind: z.enum(elementModes).optional().describe('Defaults to the current element mode.'),
      selectedOnly: z.boolean().default(false),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(5000).default(200),
    }),
    history: false,
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const kind = p.kind ?? edit.elementMode;
      return { kind, ...listElements(mesh, kind, edit, p) };
    },
  }),

  // ---- Operations ------------------------------------------------------------------------------

  defineCommand({
    id: 'mesh.extrude',
    title: 'Extrudieren',
    description:
      'Extrude the selected faces as one region: they move `distance` meters along the average of their normals (negative = inwards) ' +
      'and new side faces connect them to the rest of the mesh. Edges between selected faces are not duplicated. ' +
      'Needs at least one selected face (in vertex / edge mode: faces whose vertices are all selected); fails if the selected faces face opposite ways. ' +
      `${afterwards} the moved faces, so a following mesh.transform or another mesh.extrude continues from them. ` +
      'Returns the new mesh statistics.',
    params: z.object({ distance: z.number().default(0.5).describe('Meters along the averaged face normal.') }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return applyOp(ctx, extrudeFaces(mesh, requireFaces(mesh, edit, 'mesh.extrude'), p.distance));
    },
  }),

  defineCommand({
    id: 'mesh.inset',
    title: 'Einrücken',
    description:
      'Inset the selected faces: a smaller copy of the selected region is created inside its outline, connected to the outline by a ring of new faces. ' +
      '`thickness` is the width of that ring in meters (keep it below half the width of the faces), ' +
      '`depth` additionally moves the inner faces along their normal (negative = sunk in). ' +
      '`individual` insets every selected face on its own instead of the region as a whole. ' +
      `${afterwards} the inner faces (same count as before), so mesh.inset followed by mesh.extrude makes a panel or a window.`,
    params: z.object({
      thickness: z.number().min(0).default(0.2),
      depth: z.number().default(0),
      individual: z.boolean().default(false),
    }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return applyOp(ctx, insetFaces(mesh, requireFaces(mesh, edit, 'mesh.inset'), p.thickness, p.depth, p.individual));
    },
  }),

  defineCommand({
    id: 'mesh.bevel',
    title: 'Abkanten',
    description:
      'Bevel the selected edges: each edge is replaced by a strip of faces, cutting the corner. ' +
      '`width` is how far the new edges are offset along the adjacent faces (meters), `segments` the number of faces across the strip (more = rounder). ' +
      `Needs at least one selected edge (in vertex / face mode: edges whose two vertices are selected). ${afterwards} the new bevel faces.`,
    params: z.object({ width: z.number().positive().default(0.1), segments: z.number().int().min(1).max(32).default(1) }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const edges = selectedEdges(mesh, edit);
      if (edges.length === 0) throw new Error('mesh.bevel needs at least one selected edge, but none is selected');
      return applyOp(ctx, bevelEdges(mesh, edges, p.width, p.segments));
    },
  }),

  defineCommand({
    id: 'mesh.loop_cut',
    title: 'Schleifenschnitt',
    description:
      'Insert `cuts` evenly spaced edge loops across the ring of quads that runs through an edge: every edge of the ring ' +
      '(the given edge and the edges opposite to it, quad by quad) is split, like slicing a cylinder into shorter sections. ' +
      '`edge` is a [vertexA, vertexB] pair; it defaults to the selected edge when exactly one edge is selected. ' +
      `${afterwards} the new edges.`,
    params: z.object({ edge: edgeParam.optional(), cuts: z.number().int().min(1).max(100).default(1) }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      let edge = p.edge;
      if (!edge) {
        const edges = selectedEdges(mesh, edit);
        if (edges.length !== 1) {
          throw new Error(`mesh.loop_cut needs an edge: pass \`edge\` or select exactly one edge (${edges.length} are selected)`);
        }
        edge = [edges[0][0], edges[0][1]];
      }
      return applyOp(ctx, loopCut(mesh, requireMeshEdge(mesh, edge), p.cuts));
    },
  }),

  defineCommand({
    id: 'mesh.subdivide',
    title: 'Unterteilen',
    description:
      'Subdivide the selected faces with `cuts` cuts per edge: a quad becomes (cuts+1)^2 quads, a triangle (cuts+1)^2 triangles, ' +
      'a face with more than 4 vertices a fan of triangles around its centre. The shape does not change. ' +
      'Unselected neighbouring faces receive the new edge vertices (they become n-gons), so the mesh stays closed. ' +
      `${afterwards} the new faces.`,
    params: z.object({ cuts: z.number().int().min(1).max(10).default(1) }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      return applyOp(ctx, subdivideFaces(mesh, requireFaces(mesh, edit, 'mesh.subdivide'), p.cuts));
    },
  }),

  defineCommand({
    id: 'mesh.merge',
    title: 'Verschmelzen',
    description:
      'Merge all selected vertices (in edge / face mode: the vertices of the selected elements) into a single vertex. ' +
      "`at`: 'center' = the average of their positions, 'first' / 'last' = the position of the first / last selected vertex (selection order of mesh.select). " +
      'Faces that collapse are removed, e.g. merging the top face of a cube gives a pyramid. ' +
      `${afterwards} the merged vertex (in edge / face mode usually nothing).`,
    params: z.object({ at: z.enum(['center', 'first', 'last']).default('center') }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const vertices = selectedVertices(mesh, edit);
      if (vertices.length < 2) throw new Error(`mesh.merge needs at least two selected vertices (${vertices.length} selected)`);
      return applyOp(ctx, mergeVertices(mesh, vertices, p.at));
    },
  }),

  defineCommand({
    id: 'mesh.merge_by_distance',
    title: 'Nach Abstand verschmelzen',
    description:
      'Weld vertices that are closer than `distance` meters to each other, removing doubled vertices, collapsed faces and duplicate faces. ' +
      'Works on the selected vertices, or on the whole mesh if nothing is selected. ' +
      `Returns \`removedVertices\`. ${afterwards} the remaining vertices of the previous selection.`,
    params: z.object({ distance: z.number().min(0).default(0.0001) }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const vertices = selectedVertices(mesh, edit);
      const result = mergeByDistance(mesh, vertices.length > 0 ? vertices : null, p.distance);
      const removedVertices = (mesh.positions.length - result.mesh.positions.length) / 3;
      // Nothing to weld: leave the document untouched instead of recording an empty undo step.
      if (removedVertices === 0) return { removedVertices, ...meshStats(mesh), ...selectionResult(edit) };
      return { removedVertices, ...applyOp(ctx, result) };
    },
  }),

  defineCommand({
    id: 'mesh.delete',
    title: 'Elemente löschen',
    description:
      'Delete the selected elements. `kind` says what to delete and defaults to the current element mode: ' +
      "'faces' removes just the selected faces (leaving a hole), 'vertices' / 'edges' remove the selected vertices / edges together with every face that uses them. " +
      'The selection is converted to `kind` first. Vertices that no face uses any more are removed. ' +
      `${afterwards} empty. A hole can be closed again with mesh.fill.`,
    params: z.object({ kind: z.enum(['vertices', 'edges', 'faces']).optional() }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const kind = p.kind ?? (edit.elementMode === 'vertex' ? 'vertices' : edit.elementMode === 'edge' ? 'edges' : 'faces');
      const elements =
        kind === 'vertices'
          ? { vertices: selectedVertices(mesh, edit) }
          : kind === 'edges'
            ? { edges: selectedEdges(mesh, edit) }
            : { faces: selectedFaces(mesh, edit) };
      if (Object.values(elements)[0].length === 0) throw new Error(`mesh.delete: no ${kind} are selected`);
      return applyOp(ctx, deleteElements(mesh, elements));
    },
  }),

  defineCommand({
    id: 'mesh.transform',
    title: 'Elemente transformieren',
    description:
      'Move, rotate and/or scale the selected vertices (in edge / face mode: the vertices of the selected elements) in the local space of the object. ' +
      'Applied in the order scale, rotate, translate. `translate` is an offset in meters, `rotate` Euler XYZ angles in degrees, `scale` a factor per axis. ' +
      'Rotation and scaling happen about `pivot`, which defaults to the centre of the bounding box of the selected vertices ' +
      '(so scale [0.5,0.5,0.5] shrinks a face in place, scale [1,0,1] flattens the selection in Y). ' +
      'The topology and the selection do not change.',
    params: z.object({
      translate: vec3.optional(),
      rotate: vec3.optional().describe('Euler XYZ in degrees'),
      scale: vec3.optional(),
      pivot: vec3.optional().describe('Local-space centre for rotate and scale. Defaults to the centre of the selection.'),
    }),
    run(ctx, p) {
      const { edit, mesh } = requireEdit(docState(ctx));
      if (!p.translate && !p.rotate && !p.scale) throw new Error('Give at least one of translate, rotate or scale');
      const vertices = selectedVertices(mesh, edit);
      if (vertices.length === 0) throw new Error('mesh.transform: nothing is selected');
      return applyOp(ctx, transformVertices(mesh, vertices, p), true);
    },
  }),

  defineCommand({
    id: 'mesh.flip_normals',
    title: 'Normalen umkehren',
    description:
      'Flip the selected faces so that they face the other way (reverses their vertex order). With nothing selected, all faces are flipped. ' +
      'Use it when faces look dark or inside out. The selection does not change.',
    params: z.object({}),
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const faces = selectedVertices(mesh, edit).length === 0 ? mesh.faces.map((_, i) => i) : requireFaces(mesh, edit, 'mesh.flip_normals');
      return applyOp(ctx, flipFaces(mesh, faces), true);
    },
  }),

  defineCommand({
    id: 'mesh.fill',
    title: 'Fläche füllen',
    description:
      'Create one new face from the selection, e.g. to close a hole. Select the open edges around the hole (edges with only one face), ' +
      'or in vertex mode its vertices; the face follows that loop and is oriented like its neighbours. ' +
      'An open chain of edges also works: the face closes it with one new edge. ' +
      'Fails with an explanation if the selection is not one loop or one chain of open edges. ' +
      `${afterwards} the new face.`,
    params: z.object({}),
    run(ctx) {
      const { edit, mesh } = requireEdit(docState(ctx));
      const result =
        edit.elementMode === 'edge' ? fillFace(mesh, [], edit.edges) : fillFace(mesh, selectedVertices(mesh, edit), null);
      return applyOp(ctx, result);
    },
  }),
];
