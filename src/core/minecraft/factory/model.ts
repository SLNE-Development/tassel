// The machine definition of a factory model: defaults, names and the geometry helpers the commands, the
// validator, the sidecar exporter and the viewport share.
import { z } from 'zod';
import { cuboidFaces, portKinds } from '../../types';
import type { CuboidFaceName, DocState, FactoryMachine, FactoryPort, FactoryValue, Vec3 } from '../../types';
import { newId } from '../../state';
import { faceNormals, horizontalFacings } from './rotation';

/** Resources the editor suggests; any other id (best namespaced, e.g. 'mymod:steam') works too. */
export const builtinResources = ['item', 'fluid', 'energy', 'gas', 'heat', 'redstone', 'data', 'any'] as const;
/** Connectors the editor suggests; any other id works too. */
export const builtinConnectors = ['conveyor', 'pipe', 'cable', 'shaft', 'chute', 'direct', 'any'] as const;

/** Port ids: what the plugin looks ports up by. */
export const PORT_ID = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;
/** Resources, connectors and tags: a plain or a namespaced id. */
export const RESOURCE_ID = /^[a-z0-9_.-]+(:[a-z0-9_./-]+)?$/;
/** Machine ids must be namespaced, like Minecraft's own ids. */
export const MACHINE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
/** Free-form property keys. */
export const PROPERTY_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The largest footprint edge in blocks. */
export const MAX_FOOTPRINT = 16;

export const factoryValue = z.union([z.string(), z.number().finite(), z.boolean()]);
const finite = z.number().finite();
const cell = z.number().int();
export const facingSchema = z.enum(cuboidFaces);

export const portFieldsSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  kind: z.enum(portKinds).default('bidirectional'),
  resource: z.string().default('item'),
  connector: z.string().default('any'),
  face: facingSchema.nullable().default(null),
  position: z.tuple([finite, finite, finite]).default([8, 8, 8]),
  size: z.tuple([finite.min(0), finite.min(0)]).default([4, 4]),
  capacity: finite.nullable().default(null),
  rate: finite.nullable().default(null),
  tags: z.array(z.string()).default([]),
  properties: z.record(z.string(), factoryValue).default({}),
});

/** The machine as stored in a .tessel project file (the port `uid`s are kept, so selections survive a reload). */
export const factoryMachineSchema = z.object({
  id: z.string().default('factory:machine'),
  displayName: z.string().default(''),
  footprint: z.tuple([cell.min(1).max(MAX_FOOTPRINT), cell.min(1).max(MAX_FOOTPRINT), cell.min(1).max(MAX_FOOTPRINT)]).default([1, 1, 1]),
  anchor: z.tuple([cell.min(0), cell.min(0), cell.min(0)]).default([0, 0, 0]),
  facings: z.array(facingSchema).default([...horizontalFacings]),
  defaultFacing: facingSchema.default('north'),
  properties: z.record(z.string(), factoryValue).default({}),
  ports: z.array(portFieldsSchema.extend({ uid: z.string().min(1).optional() })).default([]),
});

/** A stored machine with every port given a uid (duplicates and missing ones get a new one). */
export function repairMachine(raw: z.output<typeof factoryMachineSchema>): FactoryMachine {
  const seen = new Set<string>();
  const ports = raw.ports.map((port): FactoryPort => {
    const uid = port.uid && !seen.has(port.uid) ? port.uid : newId();
    seen.add(uid);
    return { ...port, uid };
  });
  const anchor = raw.anchor.map((a, i) => Math.min(a, raw.footprint[i] - 1)) as Vec3;
  const facings = cuboidFaces.filter((f) => raw.facings.includes(f));
  return { ...raw, anchor, facings, ports };
}

/** A machine id from a model file name: 'factory:<name>'. */
export function defaultMachineId(fileName: string): string {
  const path = fileName.toLowerCase().replace(/[^a-z0-9_./-]/g, '_') || 'machine';
  return `factory:${path}`;
}

export function defaultMachine(fileName: string, displayName: string, overrides: Partial<FactoryMachine> = {}): FactoryMachine {
  return {
    id: defaultMachineId(fileName),
    displayName,
    footprint: [1, 1, 1],
    anchor: [0, 0, 0],
    facings: [...horizontalFacings],
    defaultFacing: 'north',
    properties: {},
    ports: [],
    ...overrides,
  };
}

export function requireFactory(state: DocState): FactoryMachine {
  if (!state.factory) throw new Error('The document is not a factory model');
  return state.factory;
}

/** The footprint as a box in model pixels: the model's own block spans 0..16. */
export function footprintBox(machine: Pick<FactoryMachine, 'footprint' | 'anchor'>): { min: Vec3; max: Vec3 } {
  return {
    min: machine.anchor.map((a) => -a * 16) as Vec3,
    max: machine.footprint.map((f, i) => (f - machine.anchor[i]) * 16) as Vec3,
  };
}

/** The centre of a face of the model's own block, in pixels: where a new port on that face goes. */
export function faceCentre(face: CuboidFaceName): Vec3 {
  const n = faceNormals[face];
  return n.map((c) => 8 + c * 8) as Vec3;
}

/** Positions sit on the pixel grid: whole pixels. */
export function snapPosition(p: Readonly<Vec3>): Vec3 {
  return p.map((v) => Math.round(v) + 0) as Vec3;
}

/** `base`, or `base_2`, `base_3`... whichever is not taken by another port. */
export function uniquePortId(ports: readonly FactoryPort[], base: string, except?: string): string {
  const taken = new Set(ports.filter((p) => p.uid !== except).map((p) => p.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/** A port by uid or by its (first matching) id. */
export function findPort(machine: FactoryMachine, ref: string): FactoryPort {
  const port = machine.ports.find((p) => p.uid === ref) ?? machine.ports.find((p) => p.id === ref);
  if (!port) {
    const ids = machine.ports.map((p) => p.id);
    throw new Error(`Port "${ref}" does not exist${ids.length > 0 ? ` (ports: ${ids.join(', ')})` : ' (the machine has no ports yet)'}`);
  }
  return port;
}

/** Merges property changes: a null value removes the key. */
export function mergeProperties(
  current: Readonly<Record<string, FactoryValue>>,
  changes: Readonly<Record<string, FactoryValue | null>>,
): Record<string, FactoryValue> {
  const next: Record<string, FactoryValue> = { ...current };
  for (const [key, value] of Object.entries(changes)) {
    if (!PROPERTY_KEY.test(key)) throw new Error(`Property key "${key}" may only contain letters, digits, "_", ".", ":" and "-" (1 to 64 characters)`);
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** A new port with defaults; `face` places it at the centre of that face of the model's own block. */
export function createPort(fields: Partial<Omit<FactoryPort, 'uid'>> & { id: string }): FactoryPort {
  const face = fields.face ?? null;
  return {
    uid: newId(),
    name: '',
    kind: 'bidirectional',
    resource: 'item',
    connector: 'any',
    size: [4, 4],
    capacity: null,
    rate: null,
    tags: [],
    properties: {},
    ...fields,
    face,
    position: snapPosition(fields.position ?? (face ? faceCentre(face) : [8, 8, 8])),
  };
}
