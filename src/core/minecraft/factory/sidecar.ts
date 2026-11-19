// The factory sidecar: `<model>.factory.json`, written next to the Java model JSON for the server plugin.
// The format is specified in docs/factory-model.md and docs/schemas/factory-model.schema.json; keep the three
// in step. Every change to the output is a schema change: additive changes keep `schema_version`, anything a
// plugin written against the old version would misread needs a new one.
import { z } from 'zod';
import type { DocState, FactoryMachine, FactoryPort, FactoryValue, Vec3 } from '../../types';
import { factoryValue, facingSchema, portFieldsSchema, repairMachine, requireFactory, factoryMachineSchema } from './model';
import { ROTATION_PIVOT, facingMatrix, facingRotations, faceNormals, facings, footprintCells, portBlock, rotateBlock, rotateFace, rotatePoint, rotatedCells } from './rotation';

export const SIDECAR_SCHEMA_VERSION = 1;
export const SIDECAR_SUFFIX = '.factory.json';

export function sidecarFileName(fileName: string): string {
  return `${fileName}${SIDECAR_SUFFIX}`;
}

interface SidecarPortPlacement {
  face: string | null;
  direction: Vec3 | null;
  position: Vec3;
  block: Vec3;
}

function portPlacement(port: FactoryPort): SidecarPortPlacement {
  return {
    face: port.face,
    direction: port.face ? faceNormals[port.face] : null,
    position: [...port.position],
    block: portBlock(port.position, port.face),
  };
}

/** The sidecar as a plain object (see docs/factory-model.md). */
export function factorySidecarObject(state: DocState): Record<string, unknown> {
  const machine = requireFactory(state);
  const cells = footprintCells(machine.footprint, machine.anchor);
  const allowed = facings.filter((f) => machine.facings.includes(f));
  return {
    schema_version: SIDECAR_SCHEMA_VERSION,
    generator: 'Tessel',
    machine: {
      id: machine.id,
      display_name: machine.displayName,
      model: state.java?.fileName ?? '',
      properties: { ...machine.properties },
    },
    footprint: { size: [...machine.footprint], anchor: [...machine.anchor], min: cells.min, max: cells.max },
    rotation: {
      authored_facing: 'north',
      default_facing: machine.defaultFacing,
      allowed_facings: allowed,
      pivot: [...ROTATION_PIVOT],
    },
    ports: machine.ports.map((port) => ({
      id: port.id,
      name: port.name,
      kind: port.kind,
      resource: port.resource,
      connector: port.connector,
      ...portPlacement(port),
      size: [...port.size],
      capacity: port.capacity,
      rate: port.rate,
      tags: [...port.tags],
      properties: { ...port.properties },
    })),
    facings: Object.fromEntries(
      allowed.map((facing) => {
        const m = facingMatrix(facing);
        return [
          facing,
          {
            blockstate: { ...facingRotations[facing] },
            matrix: m.map((row) => [...row]),
            footprint: rotatedCells(m, cells),
            ports: machine.ports.map((port) => {
              const face = port.face ? rotateFace(m, port.face) : null;
              return {
                id: port.id,
                face,
                direction: face ? faceNormals[face] : null,
                position: rotatePoint(m, port.position),
                block: rotateBlock(m, portBlock(port.position, port.face)),
              };
            }),
          },
        ];
      }),
    ),
  };
}

export function exportFactorySidecar(state: DocState): string {
  return `${stringify(factorySidecarObject(state), '')}\n`;
}

/** JSON with two-space indentation; short arrays of numbers or strings stay on one line. */
function stringify(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v === 'number' || typeof v === 'string')) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    const inner = `${indent}  `;
    return `[\n${value.map((v) => inner + stringify(v, inner)).join(',\n')}\n${indent}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const inner = `${indent}  `;
    return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringify(v, inner)}`).join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const sidecarSchema = z.object({
  schema_version: z.number().int(),
  machine: z
    .object({
      id: z.string().optional(),
      display_name: z.string().optional(),
      model: z.string().optional(),
      properties: z.record(z.string(), factoryValue).optional(),
    })
    .default({}),
  footprint: z
    .object({ size: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional(), anchor: z.tuple([z.number().int(), z.number().int(), z.number().int()]).optional() })
    .default({}),
  rotation: z.object({ default_facing: facingSchema.optional(), allowed_facings: z.array(facingSchema).optional() }).default({}),
  ports: z.array(portFieldsSchema.pick({ id: true, name: true, kind: true, resource: true, connector: true, face: true, position: true, size: true, capacity: true, rate: true, tags: true, properties: true })).default([]),
});

/**
 * Reads a sidecar back into a machine. Only the authored (north-facing) data is read; the per-facing tables
 * are derived and ignored. Throws for files that are not a sidecar or come from a newer schema version.
 */
export function parseFactorySidecar(text: string): { machine: FactoryMachine; model: string | null; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('The factory sidecar is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || !('schema_version' in raw)) throw new Error('Not a factory sidecar: "schema_version" is missing');
  const version = (raw as { schema_version: unknown }).schema_version;
  if (typeof version === 'number' && version > SIDECAR_SCHEMA_VERSION) {
    throw new Error(`The factory sidecar has schema_version ${version}; this Tessel reads up to ${SIDECAR_SCHEMA_VERSION}. Update Tessel.`);
  }
  const parsed = sidecarSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Not a valid factory sidecar: ${issue ? `${issue.path.join('.')}: ${issue.message}` : 'unknown'}`);
  }
  const data = parsed.data;
  const warnings: string[] = [];
  const size = data.footprint.size;
  const footprint = size && size.every((s) => s >= 1 && s <= 16) ? size : undefined;
  if (size && !footprint) warnings.push('footprint.size was out of range (1..16) and was reset to [1, 1, 1]');
  const machine = repairMachine(
    factoryMachineSchema.parse({
      id: data.machine.id,
      displayName: data.machine.display_name,
      properties: data.machine.properties as Record<string, FactoryValue> | undefined,
      footprint,
      anchor: footprint && data.footprint.anchor?.every((a) => a >= 0) ? data.footprint.anchor : undefined,
      facings: data.rotation.allowed_facings,
      defaultFacing: data.rotation.default_facing,
      ports: data.ports,
    }),
  );
  return { machine, model: data.machine.model ?? null, warnings };
}
