import { z } from 'zod';
import { importJavaModel } from '../minecraft/javaImport';
import {
  MAX_FOOTPRINT,
  PORT_ID,
  builtinConnectors,
  builtinResources,
  createPort,
  facingSchema,
  factoryValue,
  findPort,
  footprintBox,
  mergeProperties,
  requireFactory,
  snapPosition,
  uniquePortId,
  faceCentre,
} from '../minecraft/factory/model';
import { facingMatrix, facingRotations, portBlock, rotateBlock, rotateFace, rotatePoint } from '../minecraft/factory/rotation';
import { exportFactorySidecar, parseFactorySidecar, sidecarFileName, SIDECAR_SCHEMA_VERSION } from '../minecraft/factory/sidecar';
import { validateFactory } from '../minecraft/factory/validate';
import { addDoc, createDoc, uniqueName } from '../state';
import { cuboidFaces, portKinds } from '../types';
import type { DocState, FactoryMachine, FactoryPort } from '../types';
import { defineCommand, docState, updateDocState, type CommandContext } from './registry';

const FACTORY_HINT =
  'Factory coordinates are Minecraft model-space pixels of the model\'s own block (it spans 0..16 on every axis; +X east, +Y up, +Z south); a multi-block footprint extends that grid in steps of 16. The model and its ports are always authored facing north; the exported sidecar lists how they turn for every allowed facing.';

const portRef = z.string().describe('Port id (or its internal uid).');
const pxPosition = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const footprintVec = z.tuple([z.number().int().min(1).max(MAX_FOOTPRINT), z.number().int().min(1).max(MAX_FOOTPRINT), z.number().int().min(1).max(MAX_FOOTPRINT)]);
const cellVec = z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]);
const propertiesParam = z
  .record(z.string(), factoryValue.nullable())
  .optional()
  .describe('Free-form key-value properties (string, number or boolean), merged into the existing ones; a null value removes that key.');

const portFields = {
  name: z.string().optional().describe('Display label ("" = none).'),
  kind: z.enum(portKinds).optional().describe('input (flows into the machine), output (flows out) or bidirectional.'),
  resource: z.string().min(1).optional().describe(`What flows: ${builtinResources.join(', ')} or any custom id such as "mymod:steam".`),
  connector: z.string().min(1).optional().describe(`What attaches: ${builtinConnectors.join(', ')} or any custom id.`),
  face: facingSchema.nullable().optional().describe('The block face the port opens to: north, east, south, west, up or down.'),
  position: pxPosition.optional().describe('Centre of the opening in model pixels; rounded to whole pixels.'),
  size: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]).optional().describe('Width and height of the opening in pixels.'),
  capacity: z.number().finite().nullable().optional().describe('Buffer size in a plugin-defined unit; null = none.'),
  rate: z.number().finite().nullable().optional().describe('Throughput per tick in a plugin-defined unit; null = none.'),
  tags: z.array(z.string()).optional().describe('Replaces the tags.'),
  properties: propertiesParam,
};

function portInfo(port: FactoryPort) {
  return { ...port, block: portBlock(port.position, port.face) };
}

function machineInfo(state: DocState) {
  const machine = requireFactory(state);
  const issues = validateFactory(state);
  const { ports, ...rest } = machine;
  return { ...rest, footprintBox: footprintBox(machine), ports: ports.map(portInfo), valid: !issues.some((i) => i.severity === 'error'), issues };
}

function updateFactory(ctx: CommandContext, update: (machine: FactoryMachine) => FactoryMachine) {
  updateDocState(ctx, (s) => ({ ...s, factory: update(requireFactory(s)) }));
}

function checkPortId(machine: FactoryMachine, id: string, except?: string) {
  if (!PORT_ID.test(id)) throw new Error(`Port id "${id}" must be 1-64 characters of a-z, 0-9, "_", "." and "-", starting with a letter, digit or "_"`);
  if (machine.ports.some((p) => p.id === id && p.uid !== except)) throw new Error(`Another port already has the id "${id}"`);
}

/** The port fields of a command's params, without undefined entries and with the position snapped. */
function portChanges(p: Partial<Record<keyof typeof portFields, unknown>>, current: FactoryPort | null): Partial<FactoryPort> {
  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) if (value !== undefined && key !== 'properties') changes[key] = value;
  if (p.position) changes.position = snapPosition(p.position as [number, number, number]);
  if (p.properties) changes.properties = mergeProperties(current?.properties ?? {}, p.properties as Record<string, string | number | boolean | null>);
  return changes as Partial<FactoryPort>;
}

export const factoryCommands = [
  defineCommand({
    id: 'factory.get',
    title: 'Maschine abfragen',
    description: `Get the machine definition of a factory model: id (namespaced, e.g. "factory:crusher"), displayName, footprint (size in blocks [x, y, z]), anchor (the footprint cell the model's own block sits in), footprintBox (the footprint in model pixels), facings (allowed placements), defaultFacing, properties, ports (each with uid, id, name, kind, resource, connector, face, position, size, capacity, rate, tags, properties and block, the footprint cell it belongs to) and the validation issues. ${FACTORY_HINT}`,
    params: z.object({}),
    history: false,
    run(ctx) {
      return machineInfo(docState(ctx));
    },
  }),

  defineCommand({
    id: 'factory.set_machine',
    title: 'Maschine ändern',
    description: `Change machine-level settings of a factory model; only the given fields change. id: namespaced machine id the plugin registers (e.g. "factory:crusher"). footprint: size in blocks [x, y, z], 1..${MAX_FOOTPRINT} each, for multi-block machines. anchor: the footprint cell [x, y, z] the model's own block (pixels 0..16) sits in, default [0, 0, 0]. facings: the facings the machine may be placed with (north, east, south, west, up, down). defaultFacing: one of them. ${FACTORY_HINT}`,
    params: z.object({
      id: z.string().min(1).optional(),
      displayName: z.string().optional(),
      footprint: footprintVec.optional(),
      anchor: cellVec.optional(),
      facings: z.array(facingSchema).min(1).optional(),
      defaultFacing: facingSchema.optional(),
      properties: propertiesParam,
    }),
    run(ctx, p) {
      updateFactory(ctx, (machine) => {
        const footprint = p.footprint ?? machine.footprint;
        const anchor = p.anchor ?? (machine.anchor.map((a, i) => Math.min(a, footprint[i] - 1)) as typeof machine.anchor);
        if (anchor.some((a, i) => a >= footprint[i])) throw new Error(`The anchor [${anchor.join(', ')}] lies outside the footprint [${footprint.join(', ')}]`);
        const facings = p.facings ? cuboidFaces.filter((f) => p.facings!.includes(f)) : machine.facings;
        let defaultFacing = p.defaultFacing ?? machine.defaultFacing;
        if (p.defaultFacing && !facings.includes(p.defaultFacing)) throw new Error(`The default facing "${p.defaultFacing}" is not one of the allowed facings (${facings.join(', ')})`);
        if (!facings.includes(defaultFacing)) defaultFacing = facings[0];
        return {
          ...machine,
          ...(p.id !== undefined ? { id: p.id } : {}),
          ...(p.displayName !== undefined ? { displayName: p.displayName } : {}),
          footprint,
          anchor,
          facings,
          defaultFacing,
          properties: p.properties ? mergeProperties(machine.properties, p.properties) : machine.properties,
        };
      });
      return machineInfo(docState(ctx));
    },
  }),

  defineCommand({
    id: 'factory.add_port',
    title: 'Anschluss hinzufügen',
    description: `Add a port (a connection point: input, output or bidirectional) to a factory model. id: what the plugin looks the port up by, unique per machine (default: the kind, made unique). face: the block face it opens to; without a position it is placed at the centre of that face of the model's own block. ${FACTORY_HINT} Returns the port.`,
    params: z.object({ id: z.string().optional(), ...portFields }),
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const kind = p.kind ?? 'bidirectional';
      const id = p.id ?? uniquePortId(machine.ports, kind === 'bidirectional' ? 'port' : kind);
      checkPortId(machine, id);
      const { id: _id, ...fields } = p;
      const changes = portChanges(fields, null);
      const port = createPort({ ...changes, id, kind, position: changes.position ?? (p.face ? faceCentre(p.face) : undefined) });
      updateFactory(ctx, (m) => ({ ...m, ports: [...m.ports, port] }));
      return portInfo(port);
    },
  }),

  defineCommand({
    id: 'factory.update_port',
    title: 'Anschluss ändern',
    description: `Change a port of a factory model; only the given fields change. newId renames it (unique per machine). Positions are rounded to whole pixels. ${FACTORY_HINT} Returns the port.`,
    params: z.object({ port: portRef, newId: z.string().optional(), ...portFields }),
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const port = findPort(machine, p.port);
      if (p.newId !== undefined) checkPortId(machine, p.newId, port.uid);
      const { port: _ref, newId, ...fields } = p;
      const next: FactoryPort = { ...port, ...portChanges(fields, port), ...(newId !== undefined ? { id: newId } : {}) };
      updateFactory(ctx, (m) => ({ ...m, ports: m.ports.map((q) => (q.uid === port.uid ? next : q)) }));
      return portInfo(next);
    },
  }),

  defineCommand({
    id: 'factory.remove_ports',
    title: 'Anschlüsse entfernen',
    description: 'Remove ports from a factory model, by id (or uid). Returns the ids that were removed.',
    params: z.object({ ports: z.array(portRef).min(1) }),
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const uids = new Set(p.ports.map((ref) => findPort(machine, ref).uid));
      updateFactory(ctx, (m) => ({ ...m, ports: m.ports.filter((q) => !uids.has(q.uid)) }));
      return { removed: machine.ports.filter((q) => uids.has(q.uid)).map((q) => q.id) };
    },
  }),

  defineCommand({
    id: 'factory.duplicate_port',
    title: 'Anschluss duplizieren',
    description: `Copy a port of a factory model under a new id (default: the old id made unique), optionally on another face (then placed at the centre of that face unless a position is given) or at another position. ${FACTORY_HINT} Returns the new port.`,
    params: z.object({ port: portRef, newId: z.string().optional(), face: facingSchema.optional(), position: pxPosition.optional() }),
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const source = findPort(machine, p.port);
      const id = p.newId ?? uniquePortId(machine.ports, source.id);
      checkPortId(machine, id);
      const face = p.face ?? source.face;
      const position = p.position ?? (p.face ? faceCentre(p.face) : source.position);
      const { uid: _uid, ...fields } = source;
      const port = createPort({ ...fields, id, face, position });
      updateFactory(ctx, (m) => {
        const index = m.ports.findIndex((q) => q.uid === source.uid);
        return { ...m, ports: [...m.ports.slice(0, index + 1), port, ...m.ports.slice(index + 1)] };
      });
      return portInfo(port);
    },
  }),

  defineCommand({
    id: 'factory.reorder_port',
    title: 'Anschluss verschieben',
    description: 'Move a port of a factory model to another place in the port list (index 0 = first). The order is kept in the sidecar.',
    params: z.object({ port: portRef, index: z.number().int().min(0) }),
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const port = findPort(machine, p.port);
      updateFactory(ctx, (m) => {
        const rest = m.ports.filter((q) => q.uid !== port.uid);
        const index = Math.min(p.index, rest.length);
        return { ...m, ports: [...rest.slice(0, index), port, ...rest.slice(index)] };
      });
      return { ports: requireFactory(docState(ctx)).ports.map((q) => q.id) };
    },
  }),

  defineCommand({
    id: 'factory.place',
    title: 'Platzierung berechnen',
    description: `Show where the ports of a factory model end up when the machine is placed with a facing (the same numbers the sidecar lists under "facings"): the blockstate rotation x/y, and per port the turned face, position (model pixels) and block (footprint cell relative to the placed block). ${FACTORY_HINT}`,
    params: z.object({ facing: facingSchema }),
    history: false,
    run(ctx, p) {
      const machine = requireFactory(docState(ctx));
      const m = facingMatrix(p.facing);
      return {
        facing: p.facing,
        allowed: machine.facings.includes(p.facing),
        blockstate: facingRotations[p.facing],
        ports: machine.ports.map((port) => ({
          id: port.id,
          face: port.face ? rotateFace(m, port.face) : null,
          position: rotatePoint(m, port.position),
          block: rotateBlock(m, portBlock(port.position, port.face)),
        })),
      };
    },
  }),

  defineCommand({
    id: 'factory.validate',
    title: 'Maschine prüfen',
    description:
      'Check the machine definition of a factory model: machine id, allowed and default facing, anchor, port ids (format and duplicates), ports without a face (direction), ports outside the footprint or not on the side they face, resource/connector/tag ids, property keys and elements reaching outside the footprint. Returns { valid (no errors), issues: [{ severity, code, message, portUid?, portId?, objectId? }] }. minecraft_validate checks the model itself.',
    params: z.object({}),
    history: false,
    run(ctx) {
      const issues = validateFactory(docState(ctx));
      return { valid: !issues.some((i) => i.severity === 'error'), issues };
    },
  }),

  defineCommand({
    id: 'factory.export_sidecar',
    title: 'Fabrik-Sidecar erzeugen',
    description: `Return the factory sidecar of the document as text: the JSON (schema_version ${SIDECAR_SCHEMA_VERSION}, see docs/factory-model.md) the server plugin reads, written next to the model as <fileName>.factory.json by file_export. Also returns fileName and the validation issues.`,
    params: z.object({}),
    history: false,
    run(ctx) {
      const state = docState(ctx);
      return { fileName: sidecarFileName(state.java?.fileName ?? 'model'), text: exportFactorySidecar(state), issues: validateFactory(state) };
    },
  }),

  defineCommand({
    id: 'document.import_factory',
    title: 'Fabrik-Modell öffnen',
    description:
      'Open a factory model as a NEW factory document tab from its Minecraft Java model (.json text) and its factory sidecar (.factory.json text). Usually you want the file_open tool instead, which reads both files from disk together with the textures. images: texture PNGs by resource location, as for document_import_java. Returns { id, name, active, format, elements, ports, warnings }.',
    params: z.object({
      json: z.string().min(1).describe('The model JSON.'),
      sidecar: z.string().min(1).describe('The .factory.json text.'),
      name: z.string().min(1).default('machine'),
      fileName: z.string().min(1).optional().describe('Model file name without .json; default: name.'),
      version: z.string().optional(),
      images: z
        .record(z.string(), z.object({ data: z.string().min(1), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }))
        .optional(),
      activate: z.boolean().default(true),
    }),
    run(ctx, p) {
      const factory = parseFactorySidecar(p.sidecar);
      const imported = importJavaModel(p.json, { version: p.version, fileName: p.fileName ?? p.name, images: p.images });
      const state: DocState = { ...imported.state, format: 'minecraft_factory', factory: factory.machine };
      const names = Object.values(ctx.get().docs).map((d) => d.name);
      const doc = createDoc(uniqueName(names, p.name), state);
      ctx.set((app) => {
        const next = addDoc(app, doc);
        return p.activate ? next : { ...next, activeDocId: app.activeDocId };
      });
      return {
        id: doc.id,
        name: doc.name,
        active: p.activate,
        format: 'minecraft_factory',
        elements: state.order.length,
        ports: factory.machine.ports.length,
        warnings: [...imported.warnings, ...factory.warnings],
      };
    },
  }),
];
