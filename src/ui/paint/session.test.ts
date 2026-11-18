import { beforeEach, describe, expect, it, vi } from 'vitest';

// The app's imaging service encodes through the browser's canvas; here the same service runs on the pure codec.
vi.mock('../../imaging', async () => {
  const { createImagingService } = await import('../../imaging/service');
  const imaging = createImagingService();
  return {
    imaging,
    beginStrokePreview: imaging.beginStroke,
    compositeTexture: imaging.pixels,
  };
});

import { execute, selectActiveDoc, selectDocState, services, useApp } from '../../app/store';
import { createAppState } from '../../core/state';
import type { PaintBrush } from '../../core/types';
import * as imagingModule from '../../imaging';
import { paintStroke } from '../../imaging/pixels';
import { usePaint } from './paintStore';
import { paintSession } from './session';

const brush: PaintBrush = { color: '#000000', size: 8, opacity: 0.5, hardness: 1, spacing: 0.15, erase: false };
const SIZE = 64;
const white = Uint8ClampedArray.from({ length: SIZE * SIZE * 4 }, () => 255);

const doc = () => selectActiveDoc(useApp.getState());
const state = () => selectDocState(useApp.getState());
const texture = () => Object.values(state().textures)[0];

async function settled(): Promise<void> {
  await vi.waitFor(() => expect(paintSession.painting).toBe(false));
}

describe('PaintSession', () => {
  beforeEach(async () => {
    services.imaging = (imagingModule as unknown as { imaging: typeof services.imaging }).imaging;
    useApp.setState(createAppState(), true);
    usePaint.setState({ slot: 'baseColor', activeLayer: {}, heightTexture: {} });
    await execute('scene.add_primitive', { type: 'cube' });
    const { id: materialId } = (await execute('material.create', { assignTo: [state().activeId] })) as { id: string };
    await execute('uv.unwrap', { method: 'smart' });
    await execute('paint.create_texture', { width: SIZE, height: SIZE, color: '#ffffff', materialId, slot: 'baseColor' });
  });

  it('commits a drag that breaks at seams as ONE paint.stroke: one undo step, pixel-identical to its preview', async () => {
    const before = texture();
    const past = doc().past.length;
    // A cross of two unconnected lines at 50 %, with the points arriving before the preview is ready.
    expect(paintSession.begin(brush)).toBe(true);
    paintSession.split(); // before the first point: no break
    paintSession.add([[0.1, 0.5]]);
    paintSession.add([[0.9, 0.5]]);
    paintSession.split();
    paintSession.add([[0.5, 0.9]]);
    // ... and the rest once it shows.
    await vi.waitFor(() => expect(paintSession.shown).toBe(before));
    const preview = paintSession.pixels!;
    paintSession.add([[0.5, 0.1]]);
    const expected = paintStroke(white, SIZE, SIZE, brush, [[0.1, 0.5], [0.9, 0.5], [0.5, 0.9], [0.5, 0.1]], [2]);
    expect(preview).toEqual(expected);
    const previewed = new Uint8ClampedArray(preview);
    expect(doc().past).toHaveLength(past); // nothing committed during the drag
    paintSession.end();
    await settled();

    expect(doc().past).toHaveLength(past + 1);
    expect(texture()).not.toBe(before);
    expect(paintSession.shown).toBe(texture());
    expect(paintSession.pixels).toEqual(previewed);
    expect(paintSession.previewMismatch).toBe(0);
    const at = (x: number, y: number) => [...paintSession.pixels!.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4)];
    expect(at(32, 32)).toEqual([128, 128, 128, 255]); // the crossing: no build-up
    expect(at(46, 20)).toEqual([255, 255, 255, 255]); // no line from the end of one polyline to the start of the next

    // One undo removes both marks.
    await execute('history.undo');
    expect(texture()).toBe(before);
    expect(doc().past).toHaveLength(past);
  });

  it('commits an unbroken drag as a plain stroke and nothing for a drag without points', async () => {
    const past = doc().past.length;
    paintSession.begin(brush);
    paintSession.split();
    paintSession.end();
    await settled();
    expect(doc().past).toHaveLength(past);

    paintSession.begin(brush);
    paintSession.add([[0.2, 0.2], [0.8, 0.8]]);
    paintSession.split(); // a break at the very end is none
    paintSession.end();
    await settled();
    expect(doc().past).toHaveLength(past + 1);
    expect(paintSession.pixels).toEqual(paintStroke(white, SIZE, SIZE, brush, [[0.2, 0.2], [0.8, 0.8]]));
  });
});
