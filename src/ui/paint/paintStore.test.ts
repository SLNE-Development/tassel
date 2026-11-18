import { beforeEach, describe, expect, it } from 'vitest';
import { execute, selectDocState, useApp } from '../../app/store';
import { createAppState } from '../../core/state';
import { brushColor, currentTarget, greyHex, isScalarSlot, setBrushSize, stepBrushSize, usePaint } from './paintStore';

const state = () => selectDocState(useApp.getState());

describe('paint target', () => {
  beforeEach(() => {
    useApp.setState(createAppState(), true);
    usePaint.setState({ slot: 'baseColor', activeLayer: {}, heightTexture: {} });
  });

  it('names what is missing, in the order it has to be fixed', async () => {
    expect(currentTarget().problem).toBe('noObject');
    await execute('scene.add_primitive', { type: 'cube' });
    expect(currentTarget().problem).toBe('noMaterial');
    await execute('material.create', { assignTo: [state().activeId] });
    // Primitives may come with UVs or without; either way the texture is what is missing last.
    if (currentTarget().problem === 'noUvs') await execute('uv.unwrap', { method: 'smart' });
    expect(currentTarget().problem).toBe('noTexture');
    await execute('edit.enter', {});
    expect(currentTarget().problem).toBe('editMode');
  });

  it('paints on the texture of the chosen slot and on its top layer by default', async () => {
    await execute('scene.add_primitive', { type: 'cube' });
    await execute('material.create', { assignTo: [state().activeId] });
    await execute('uv.unwrap', { method: 'smart' });
    const material = Object.values(state().materials)[0];
    const layers = [
      { id: 'a', name: 'A', visible: true, opacity: 1, blend: 'normal' as const, data: '' },
      { id: 'b', name: 'B', visible: true, opacity: 1, blend: 'normal' as const, data: '' },
    ];
    const texture = { id: 't', name: 'T', mimeType: 'image/png' as const, data: '', width: 4, height: 4, layers };
    useApp.setState((app) => {
      const doc = app.docs[app.activeDocId];
      const next = { ...doc.state, textures: { t: texture }, materials: { [material.id]: { ...material, maps: { roughness: 't' } } } };
      return { ...app, docs: { ...app.docs, [doc.id]: { ...doc, state: next } } };
    });
    expect(currentTarget().problem).toBe('noTexture');
    usePaint.setState({ slot: 'roughness' });
    expect(currentTarget()).toMatchObject({ problem: null, texture, layer: layers[1] });
    usePaint.setState({ activeLayer: { t: 'a' } });
    expect(currentTarget().layer).toBe(layers[0]);
    // The height texture is not bound to the material; the paint store remembers it.
    usePaint.setState({ slot: 'height' });
    expect(currentTarget().problem).toBe('noTexture');
    usePaint.setState({ heightTexture: { [material.id]: 't' } });
    expect(currentTarget().texture).toBe(texture);
  });
});

describe('brush', () => {
  it('paints greys on scalar slots', () => {
    expect(isScalarSlot('baseColor')).toBe(false);
    expect(isScalarSlot('emissive')).toBe(false);
    expect(isScalarSlot('roughness')).toBe(true);
    expect(isScalarSlot('height')).toBe(true);
    expect(greyHex(0.6)).toBe('#999999');
    usePaint.setState({ slot: 'roughness', value: 0.1, color: '#ff0000' });
    expect(brushColor()).toBe('#1a1a1a');
    usePaint.setState({ slot: 'baseColor' });
    expect(brushColor()).toBe('#ff0000');
  });

  it('steps its size finer when small and keeps it in range', () => {
    setBrushSize(8);
    stepBrushSize(1);
    expect(usePaint.getState().size).toBe(9);
    setBrushSize(100);
    stepBrushSize(-1);
    expect(usePaint.getState().size).toBe(90);
    setBrushSize(5000);
    expect(usePaint.getState().size).toBe(1024);
    setBrushSize(0);
    expect(usePaint.getState().size).toBe(1);
  });
});
