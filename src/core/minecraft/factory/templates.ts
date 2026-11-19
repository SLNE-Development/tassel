// Starting points for common machines, offered in File > New and by document_new (template).
import type { DocState, FactoryMachine, SceneObject, Vec3 } from '../../types';
import { newId } from '../../state';
import { createCuboid, syncCuboidObject, uvSize } from '../cuboid';
import { modelToWorld, subVec, tidy } from '../space';
import { createPort, defaultMachine } from './model';
import type { FactoryPort } from '../../types';

export const factoryTemplates = ['empty', 'machine', 'conveyor', 'pipe_junction'] as const;
export type FactoryTemplate = (typeof factoryTemplates)[number];

interface TemplateElement {
  name: string;
  from: Vec3;
  to: Vec3;
  /** Marker colour 0-7. */
  color: number;
}

interface TemplateDef {
  elements: TemplateElement[];
  machine: Partial<FactoryMachine>;
}

const port = (fields: Parameters<typeof createPort>[0]): FactoryPort => createPort(fields);

function definition(template: FactoryTemplate): TemplateDef {
  switch (template) {
    case 'empty':
      return { elements: [], machine: {} };
    case 'machine':
      // A single-block machine: items come in on the west side and leave on the east side.
      return {
        elements: [
          { name: 'base', from: [0, 0, 0], to: [16, 2, 16], color: 0 },
          { name: 'body', from: [1, 2, 1], to: [15, 14, 15], color: 1 },
          { name: 'top', from: [0, 14, 0], to: [16, 16, 16], color: 0 },
          { name: 'input_hatch', from: [0, 5, 5], to: [1, 11, 11], color: 4 },
          { name: 'output_hatch', from: [15, 5, 5], to: [16, 11, 11], color: 3 },
        ],
        machine: {
          ports: [
            port({ id: 'input', name: 'Input', kind: 'input', resource: 'item', connector: 'conveyor', face: 'west', position: [0, 8, 8], size: [6, 6] }),
            port({ id: 'output', name: 'Output', kind: 'output', resource: 'item', connector: 'conveyor', face: 'east', position: [16, 8, 8], size: [6, 6] }),
          ],
        },
      };
    case 'conveyor':
      // A straight belt segment that carries items towards its front (north).
      return {
        elements: [
          { name: 'belt', from: [0, 0, 0], to: [16, 4, 16], color: 0 },
          { name: 'rail_west', from: [0, 4, 0], to: [1, 6, 16], color: 2 },
          { name: 'rail_east', from: [15, 4, 0], to: [16, 6, 16], color: 2 },
        ],
        machine: {
          properties: { speed: 1 },
          ports: [
            port({ id: 'in', name: 'Belt in', kind: 'input', resource: 'item', connector: 'conveyor', face: 'south', position: [8, 4, 16], size: [14, 2] }),
            port({ id: 'out', name: 'Belt out', kind: 'output', resource: 'item', connector: 'conveyor', face: 'north', position: [8, 4, 0], size: [14, 2] }),
          ],
        },
      };
    case 'pipe_junction': {
      // A six-way pipe junction: a hub with an arm and a fluid connection on every side.
      const arm: Record<string, [Vec3, Vec3]> = {
        north: [[6, 6, 0], [10, 10, 5]],
        south: [[6, 6, 11], [10, 10, 16]],
        west: [[0, 6, 6], [5, 10, 10]],
        east: [[11, 6, 6], [16, 10, 10]],
        down: [[6, 0, 6], [10, 5, 10]],
        up: [[6, 11, 6], [10, 16, 10]],
      };
      const faces = ['north', 'east', 'south', 'west', 'up', 'down'] as const;
      return {
        elements: [{ name: 'hub', from: [5, 5, 5], to: [11, 11, 11], color: 5 }, ...faces.map((f) => ({ name: `arm_${f}`, from: arm[f][0], to: arm[f][1], color: 6 }))],
        machine: {
          // The junction looks the same every way, so it is never turned.
          facings: ['north'],
          properties: { pressure: 1 },
          ports: faces.map((face) => port({ id: face, kind: 'bidirectional', resource: 'fluid', connector: 'pipe', face, size: [4, 4], capacity: 1000 })),
        },
      };
    }
  }
}

/** Adds the template's elements and machine to a new factory document state. */
export function applyFactoryTemplate(state: DocState, template: FactoryTemplate, names: { fileName: string; displayName: string }): DocState {
  const def = definition(template);
  const size = uvSize(state);
  const objects: Record<string, SceneObject> = { ...state.objects };
  const order = [...state.order];
  for (const el of def.elements) {
    const origin = [0, 1, 2].map((i) => tidy((el.from[i] + el.to[i]) / 2)) as Vec3;
    const cuboid = { ...createCuboid(subVec(el.from, origin), subVec(el.to, origin), null, size), color: el.color };
    const obj: SceneObject = {
      id: newId(),
      name: el.name,
      visible: true,
      transform: { position: modelToWorld(origin), rotation: [0, 0, 0], scale: [1, 1, 1] },
      mesh: { positions: [], faces: [] },
      modifiers: [],
      smooth: false,
      groupId: null,
      materialId: null,
      cuboid,
    };
    objects[obj.id] = syncCuboidObject(obj, size);
    order.push(obj.id);
  }
  return { ...state, objects, order, factory: defaultMachine(names.fileName, names.displayName, def.machine) };
}
