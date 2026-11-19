import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject } from '../../project';
import { activeDoc } from '../../state';
import { exportJavaModel } from '../javaExport';
import { testApp, type TestApp } from '../testing';
import { facingMatrix, faceOf, portBlock, rotateBlock, rotateFace, rotatePoint, rotatedCells, footprintCells } from './rotation';
import { MACHINE_ID, PORT_ID, RESOURCE_ID } from './model';
import { SIDECAR_SCHEMA_VERSION, exportFactorySidecar, parseFactorySidecar } from './sidecar';
import { validateFactory } from './validate';

const golden = (name: string) => new URL(`./golden/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

async function factoryApp(params: Record<string, unknown> = {}): Promise<TestApp> {
  const t = testApp();
  await t.run('document.new', { name: 'Crusher', format: 'minecraft_factory', ...params });
  return t;
}

/** A two-block-tall machine with every port feature, built through the commands. */
async function fullMachine() {
  const t = await factoryApp({ template: 'machine', fileName: 'crusher', machineId: 'factory:crusher' });
  await t.run('factory.set_machine', {
    displayName: 'Crusher',
    footprint: [1, 2, 1],
    facings: ['north', 'east', 'south', 'west', 'up'],
    defaultFacing: 'south',
    properties: { tier: 2, powered: true, recipe_type: 'factory:crushing' },
  });
  await t.run('factory.add_port', {
    id: 'energy',
    name: 'Power',
    kind: 'input',
    resource: 'energy',
    connector: 'cable',
    face: 'up',
    position: [8, 32, 8],
    size: [2, 2],
    capacity: 10000,
    rate: 128.5,
    tags: ['fe'],
    properties: { voltage: 'low' },
  });
  await t.run('factory.add_port', { id: 'steam', kind: 'output', resource: 'mymod:steam', connector: 'pipe', face: 'north', position: [8.4, 24, 0] });
  return t;
}

describe('factory rotation', () => {
  it('turns like blockstate variants', () => {
    expect(rotateFace(facingMatrix('east'), 'north')).toBe('east');
    expect(rotateFace(facingMatrix('south'), 'north')).toBe('south');
    expect(rotateFace(facingMatrix('west'), 'north')).toBe('west');
    expect(rotateFace(facingMatrix('down'), 'north')).toBe('down');
    expect(rotateFace(facingMatrix('up'), 'north')).toBe('up');
    expect(rotateFace(facingMatrix('east'), 'up')).toBe('up');
    expect(rotateFace(facingMatrix('down'), 'up')).toBe('north');
    expect(faceOf([0, 0, -1])).toBe('north');
  });

  it('turns points about the centre of the block and keeps blocks whole', () => {
    expect(rotatePoint(facingMatrix('east'), [8, 8, 0])).toEqual([16, 8, 8]);
    expect(rotatePoint(facingMatrix('north'), [3, 4, 5])).toEqual([3, 4, 5]);
    expect(portBlock([16, 8, 8], 'east')).toEqual([0, 0, 0]);
    expect(portBlock([8, 32, 8], 'up')).toEqual([0, 1, 0]);
    expect(portBlock([8, 16, 8], null)).toEqual([0, 1, 0]);
    // Turned to face up (x 270), the block above the placed one ends up south of it.
    expect(rotateBlock(facingMatrix('up'), [0, 1, 0])).toEqual([0, 0, 1]);
    expect(rotateBlock(facingMatrix('down'), [0, 1, 0])).toEqual([0, 0, -1]);
    expect(rotatedCells(facingMatrix('east'), footprintCells([2, 1, 3], [0, 0, 0]))).toEqual({ min: [-2, 0, 0], max: [0, 0, 1] });
  });
});

describe('factory documents', () => {
  it('are Minecraft documents with a machine', async () => {
    const t = await factoryApp();
    expect(t.state().format).toBe('minecraft_factory');
    expect(t.state().java?.fileName).toBe('crusher');
    expect(t.state().factory).toMatchObject({ id: 'factory:crusher', displayName: 'Crusher', footprint: [1, 1, 1], ports: [] });
    // Everything a Java document can do works here.
    await t.run('cuboid.add', { from: [0, 0, 0], to: [16, 8, 16] });
    expect(exportJavaModel(t.state())).toContain('"elements"');
    await expect(t.run('minecraft.validate')).resolves.toMatchObject({ valid: true });
  });

  it('keep factory tools out of other formats', async () => {
    const t = testApp();
    await t.run('document.new', { format: 'minecraft_java' });
    await expect(t.run('factory.add_port', { face: 'north' })).rejects.toThrow(/only works in Minecraft Factory Model documents/);
    await t.run('document.new', { format: 'free' });
    await expect(t.run('factory.get')).rejects.toThrow(/not available in Free model documents/);
  });

  it('start from templates', async () => {
    for (const [template, elements, ports] of [
      ['empty', 0, 0],
      ['machine', 5, 2],
      ['conveyor', 3, 2],
      ['pipe_junction', 7, 6],
    ] as const) {
      const t = await factoryApp({ template });
      expect(t.state().order).toHaveLength(elements);
      expect(t.state().factory!.ports).toHaveLength(ports);
      expect(validateFactory(t.state()).filter((i) => i.severity === 'error'), template).toEqual([]);
      expect(Object.values(t.state().objects).every((o) => o.mesh.faces.length === 6)).toBe(true);
    }
  });

  it('edit ports through the commands', async () => {
    const t = await factoryApp();
    const a = await t.run('factory.add_port', { kind: 'input', face: 'west' });
    expect(a).toMatchObject({ id: 'input', face: 'west', position: [0, 8, 8], block: [0, 0, 0], resource: 'item' });
    const b = await t.run('factory.add_port', { kind: 'input', position: [16.4, 7.6, 3] });
    expect(b).toMatchObject({ id: 'input_2', face: null, position: [16, 8, 3] });
    await expect(t.run('factory.add_port', { id: 'input' })).rejects.toThrow(/already has the id/);
    await expect(t.run('factory.add_port', { id: 'Bad Id' })).rejects.toThrow(/must be 1-64 characters/);
    await t.run('factory.update_port', { port: 'input_2', newId: 'fuel', face: 'east', properties: { burn: 200, x: null } });
    expect(t.state().factory!.ports[1]).toMatchObject({ id: 'fuel', face: 'east', properties: { burn: 200 } });
    await t.run('factory.update_port', { port: 'fuel', properties: { burn: null } });
    expect(t.state().factory!.ports[1].properties).toEqual({});
    const copy = await t.run('factory.duplicate_port', { port: 'fuel', face: 'south' });
    expect(copy).toMatchObject({ id: 'fuel_2', face: 'south', position: [8, 8, 16] });
    await t.run('factory.reorder_port', { port: 'fuel_2', index: 0 });
    expect(t.state().factory!.ports.map((p) => p.id)).toEqual(['fuel_2', 'input', 'fuel']);
    await t.run('factory.remove_ports', { ports: ['input', 'fuel_2'] });
    expect(t.state().factory!.ports.map((p) => p.id)).toEqual(['fuel']);
  });

  it('change the machine', async () => {
    const t = await factoryApp();
    await t.run('factory.set_machine', { footprint: [3, 1, 2], anchor: [1, 0, 0], properties: { a: 1 } });
    expect(t.state().factory).toMatchObject({ footprint: [3, 1, 2], anchor: [1, 0, 0], properties: { a: 1 } });
    await expect(t.run('factory.set_machine', { anchor: [3, 0, 0] })).rejects.toThrow(/outside the footprint/);
    await expect(t.run('factory.set_machine', { facings: ['north'], defaultFacing: 'east' })).rejects.toThrow(/not one of the allowed/);
    await t.run('factory.set_machine', { facings: ['up', 'east'] });
    expect(t.state().factory).toMatchObject({ facings: ['east', 'up'], defaultFacing: 'east' });
    // A smaller footprint pulls the anchor in.
    await t.run('factory.set_machine', { footprint: [1, 1, 1] });
    expect(t.state().factory!.anchor).toEqual([0, 0, 0]);
    await expect(t.run('factory.set_machine', { properties: { 'bad key': 1 } })).rejects.toThrow(/Property key/);
  });

  it('report validation problems', async () => {
    const t = await factoryApp();
    await t.run('factory.add_port', { id: 'a', face: 'north', position: [8, 8, 4] });
    await t.run('factory.add_port', { id: 'b', position: [20, 8, 8], resource: 'Not Valid' });
    await t.run('factory.set_machine', { id: 'no_namespace' });
    await t.run('cuboid.add', { from: [0, 0, 0], to: [16, 20, 16] });
    const codes = validateFactory(t.state()).map((i) => `${i.severity}:${i.code}${i.portId ? `:${i.portId}` : ''}`);
    expect(codes).toEqual(['error:machine_id', 'warning:port_off_face:a', 'error:missing_direction:b', 'error:port_outside:b', 'error:resource:b', 'warning:element_outside']);
    // Duplicate ids only come from files; the commands refuse them.
    const sidecar = JSON.parse(exportFactorySidecar(t.state()));
    sidecar.ports[1].id = 'a';
    const { machine } = parseFactorySidecar(JSON.stringify(sidecar));
    const dup = validateFactory({ ...t.state(), factory: machine }).filter((i) => i.code === 'duplicate_port_id');
    expect(dup).toHaveLength(2);
    expect(await t.run('factory.validate')).toMatchObject({ valid: false });
  });
});

describe('factory sidecar (schema_version 1)', () => {
  it('matches the golden file for a machine using every feature', async () => {
    const t = await fullMachine();
    await expect(exportFactorySidecar(t.state())).toMatchFileSnapshot(golden('crusher.factory.json'));
    await expect(exportJavaModel(t.state())).toMatchFileSnapshot(golden('crusher.json'));
  });

  it('matches the golden files of the templates', async () => {
    for (const template of ['conveyor', 'pipe_junction'] as const) {
      const t = await factoryApp({ template, fileName: template, machineId: `factory:${template}`, name: template });
      await expect(exportFactorySidecar(t.state())).toMatchFileSnapshot(golden(`${template}.factory.json`));
    }
  });

  it('lists every allowed facing with turned ports', async () => {
    const t = await fullMachine();
    const sidecar = JSON.parse(exportFactorySidecar(t.state()));
    expect(Object.keys(sidecar.facings)).toEqual(['north', 'east', 'south', 'west', 'up']);
    expect(sidecar.facings.east.blockstate).toEqual({ x: 0, y: 90 });
    const input = (facing: string) => sidecar.facings[facing].ports.find((p: { id: string }) => p.id === 'input');
    expect(input('north')).toMatchObject({ face: 'west', position: [0, 8, 8], block: [0, 0, 0] });
    expect(input('east')).toMatchObject({ face: 'north', position: [8, 8, 0], direction: [0, 0, -1] });
    expect(input('south')).toMatchObject({ face: 'east', position: [16, 8, 8] });
    const energy = sidecar.facings.up.ports.find((p: { id: string }) => p.id === 'energy');
    expect(energy).toMatchObject({ face: 'south', block: [0, 0, 1] });
    expect(sidecar.facings.up.footprint).toEqual({ min: [0, 0, 0], max: [0, 0, 1] });
  });

  it('round-trips through import', async () => {
    const t = await fullMachine();
    const model = exportJavaModel(t.state());
    const sidecar = exportFactorySidecar(t.state());
    const opened = await t.run('document.import_factory', { json: model, sidecar, name: 'crusher' });
    expect(opened).toMatchObject({ format: 'minecraft_factory', ports: 4, warnings: [] });
    expect(t.state().format).toBe('minecraft_factory');
    expect(exportFactorySidecar(t.state())).toBe(sidecar);
    expect(exportJavaModel(t.state())).toBe(model);
  });

  it('refuses files that are not a sidecar or too new', () => {
    expect(() => parseFactorySidecar('{}')).toThrow(/schema_version/);
    expect(() => parseFactorySidecar('{"schema_version": 2}')).toThrow(/reads up to 1/);
    expect(() => parseFactorySidecar('nope')).toThrow(/not valid JSON/);
    expect(parseFactorySidecar('{"schema_version": 1, "footprint": {"size": [0, 1, 1]}}').warnings).toHaveLength(1);
  });

  it('is written by export.file next to the model', async () => {
    const t = await factoryApp({ template: 'conveyor' });
    const exported = await t.run('export.file', { format: 'json' });
    expect(exported.fileName).toBe('crusher.json');
    expect(exported.sidecar.fileName).toBe('crusher.factory.json');
    expect(JSON.parse(exported.sidecar.text).schema_version).toBe(1);
    const java = testApp();
    await java.run('document.new', { format: 'minecraft_java' });
    expect((await java.run('export.file', { format: 'json' })).sidecar).toBeUndefined();
  });
});

describe('factory project files', () => {
  it('keep the machine and port uids', async () => {
    const t = await fullMachine();
    const text = serializeProject(activeDoc(t.app()));
    const loaded = parseProject(text);
    expect(loaded.state.format).toBe('minecraft_factory');
    expect(loaded.state.factory).toEqual(t.state().factory);
    expect(loaded.state.java).toEqual(t.state().java);
  });

  it('give a factory file without a machine the defaults', async () => {
    const t = await factoryApp();
    const raw = JSON.parse(serializeProject(activeDoc(t.app())));
    delete raw.factory;
    expect(parseProject(JSON.stringify(raw)).state.factory).toMatchObject({ id: 'factory:machine', footprint: [1, 1, 1] });
  });
});

describe('factory sidecar JSON Schema (docs/schemas/factory-model.schema.json)', () => {
  const schemaPath = new URL('../../../../docs/schemas/factory-model.schema.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as any;

  it('describes the version and every key the exporter writes', async () => {
    expect(schema.properties.schema_version.const).toBe(SIDECAR_SCHEMA_VERSION);
    const t = await fullMachine();
    const sidecar = JSON.parse(exportFactorySidecar(t.state()));
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(sidecar)).toEqual(keys(schema.properties));
    expect(keys(sidecar)).toEqual(expect.arrayContaining(schema.required));
    for (const part of ['machine', 'footprint', 'rotation'] as const) expect(keys(sidecar[part]), part).toEqual([...schema.properties[part].required].sort());
    for (const port of sidecar.ports) expect(keys(port)).toEqual([...schema.$defs.port.required].sort());
    for (const placement of Object.values(sidecar.facings) as { ports: object[] }[]) {
      expect(keys(placement)).toEqual([...schema.$defs.placement.required].sort());
      for (const port of placement.ports) expect(keys(port)).toEqual([...schema.$defs.placement.properties.ports.items.required].sort());
    }
    expect(schema.$defs.port.properties.id.pattern).toBe(PORT_ID.source);
    expect(schema.properties.machine.properties.id.pattern).toBe(MACHINE_ID.source);
    expect(schema.$defs.id.pattern).toBe(RESOURCE_ID.source);
  });
});
