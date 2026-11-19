import { describe, expect, it } from 'vitest';
import { centeredView, fitZoom, MAX_ZOOM, MIN_ZOOM, screenToTexture, selectionEdges, stepZoom, wrap, zoomAt } from './editorMath';

describe('view', () => {
  it('fits with an integer zoom', () => {
    expect(fitZoom(16, 16, 500, 400)).toBe(Math.floor(352 / 16));
    expect(fitZoom(512, 512, 400, 400)).toBeCloseTo(352 / 512);
    expect(fitZoom(1, 1, 5000, 5000)).toBe(MAX_ZOOM);
    expect(fitZoom(4096, 4096, 100, 100)).toBe(MIN_ZOOM);
  });

  it('centres', () => {
    expect(centeredView(16, 16, 200, 100, 4)).toEqual({ zoom: 4, panX: 68, panY: 18 });
  });

  it('steps', () => {
    expect(stepZoom(4, 1)).toBe(5);
    expect(stepZoom(4, -1)).toBe(3);
    expect(stepZoom(1, -1)).toBe(0.5);
    expect(stepZoom(0.5, 1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it('zooms around a point', () => {
    const view = { zoom: 4, panX: 10, panY: 20 };
    const [tx, ty] = screenToTexture(view, 50, 60);
    const next = zoomAt(view, 8, 50, 60);
    expect(screenToTexture(next, 50, 60)).toEqual([tx, ty]);
  });

  it('wraps', () => {
    expect(wrap(-1, 16)).toBe(15);
    expect(wrap(16, 16)).toBe(0);
    expect(wrap(5, 16)).toBe(5);
  });
});

describe('selectionEdges', () => {
  it('outlines a single pixel', () => {
    const mask = new Uint8Array(9);
    mask[4] = 1;
    expect(selectionEdges(mask, 3, 3)).toHaveLength(4);
  });

  it('outlines a 2x2 block with 8 edges', () => {
    const mask = new Uint8Array(16);
    for (const i of [5, 6, 9, 10]) mask[i] = 1;
    expect(selectionEdges(mask, 4, 4)).toHaveLength(8);
  });

  it('closes a frame strip at its rows', () => {
    const mask = new Uint8Array(4 * 4).fill(1);
    // rows 2..3 only: 4 top + 4 bottom + 2 left + 2 right
    expect(selectionEdges(mask, 4, 4, 2, 2)).toHaveLength(12);
  });
});
