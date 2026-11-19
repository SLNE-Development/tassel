// Checks the machine definition of a factory model for what a plugin could not use or would misread.
import type { DocState } from '../../types';
import { modelBox } from '../cuboid';
import { MACHINE_ID, PORT_ID, PROPERTY_KEY, RESOURCE_ID, footprintBox } from './model';
import { faceNormals } from './rotation';

export type FactoryIssueCode =
  | 'machine_id'
  | 'no_facings'
  | 'default_facing'
  | 'anchor'
  | 'property_key'
  | 'port_id'
  | 'duplicate_port_id'
  | 'missing_direction'
  | 'port_outside'
  | 'port_off_face'
  | 'resource'
  | 'connector'
  | 'tag'
  | 'element_outside';

export interface FactoryIssue {
  severity: 'error' | 'warning';
  code: FactoryIssueCode;
  /** English, for MCP clients; the UI translates by `code`. */
  message: string;
  /** The port the issue is about (its uid and id). */
  portUid?: string;
  portId?: string;
  /** The element the issue is about. */
  objectId?: string;
}

export function validateFactory(state: DocState): FactoryIssue[] {
  const machine = state.factory;
  if (!machine) return [];
  const issues: FactoryIssue[] = [];
  const error = (code: FactoryIssueCode, message: string, extra: Partial<FactoryIssue> = {}) => issues.push({ severity: 'error', code, message, ...extra });
  const warning = (code: FactoryIssueCode, message: string, extra: Partial<FactoryIssue> = {}) => issues.push({ severity: 'warning', code, message, ...extra });

  if (!MACHINE_ID.test(machine.id)) error('machine_id', `Machine id "${machine.id}" must be a namespaced id like "factory:crusher" (a-z, 0-9, "_", ".", "-", "/")`);
  if (machine.facings.length === 0) error('no_facings', 'The machine allows no facing; allow at least one');
  else if (!machine.facings.includes(machine.defaultFacing)) error('default_facing', `The default facing "${machine.defaultFacing}" is not one of the allowed facings`);
  if (machine.anchor.some((a, i) => a < 0 || a >= machine.footprint[i])) error('anchor', 'The anchor block lies outside the footprint');
  for (const key of Object.keys(machine.properties)) if (!PROPERTY_KEY.test(key)) error('property_key', `Machine property key "${key}" is not allowed`);

  const box = footprintBox(machine);
  const counts = new Map<string, number>();
  for (const port of machine.ports) counts.set(port.id, (counts.get(port.id) ?? 0) + 1);
  for (const port of machine.ports) {
    const at = { portUid: port.uid, portId: port.id };
    const label = port.id || '(no id)';
    if (!PORT_ID.test(port.id)) error('port_id', `Port id "${port.id}" must be 1-64 characters of a-z, 0-9, "_", "." and "-", starting with a letter, digit or "_"`, at);
    if ((counts.get(port.id) ?? 0) > 1) error('duplicate_port_id', `Port id "${port.id}" is used by ${counts.get(port.id)} ports; ids must be unique`, at);
    if (port.face === null) error('missing_direction', `Port "${label}" has no face (direction)`, at);
    if (port.position.some((v, i) => v < box.min[i] || v > box.max[i])) {
      error('port_outside', `Port "${label}" at [${port.position.join(', ')}] lies outside the footprint [${box.min.join(', ')}]..[${box.max.join(', ')}]`, at);
    } else if (port.face !== null) {
      // A port normally sits on the footprint's outer face it opens to.
      const n = faceNormals[port.face];
      const axis = n.findIndex((c) => c !== 0);
      const plane = n[axis] > 0 ? box.max[axis] : box.min[axis];
      if (port.position[axis] !== plane) {
        warning('port_off_face', `Port "${label}" faces ${port.face} but is not on the ${port.face} side of the footprint (${'xyz'[axis]} = ${plane})`, at);
      }
    }
    if (!RESOURCE_ID.test(port.resource)) error('resource', `Resource "${port.resource}" of port "${label}" must be an id like "fluid" or "mymod:steam"`, at);
    if (!RESOURCE_ID.test(port.connector)) error('connector', `Connector "${port.connector}" of port "${label}" must be an id like "pipe" or "mymod:belt"`, at);
    for (const tag of port.tags) if (!RESOURCE_ID.test(tag)) error('tag', `Tag "${tag}" of port "${label}" must be an id like "fast" or "mymod:hot"`, at);
    for (const key of Object.keys(port.properties)) if (!PROPERTY_KEY.test(key)) error('property_key', `Property key "${key}" of port "${label}" is not allowed`, at);
  }

  for (const id of state.order) {
    const obj = state.objects[id];
    if (!obj.cuboid || !obj.cuboid.export) continue;
    const { from, to } = modelBox({ ...obj, cuboid: obj.cuboid });
    const lo = from.map((v, i) => Math.min(v, to[i]));
    const hi = from.map((v, i) => Math.max(v, to[i]));
    if (lo.some((v, i) => v < box.min[i]) || hi.some((v, i) => v > box.max[i])) {
      warning('element_outside', `Element "${obj.name}" reaches outside the machine's footprint`, { objectId: id });
    }
  }
  return issues;
}
