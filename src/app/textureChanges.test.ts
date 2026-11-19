import { describe, expect, it } from 'vitest';
import { createImagingService } from '../imaging';
import { encodePng } from '../imaging/png';
import { toBase64 } from '../io/bytes';
import { minecraftApp } from '../core/minecraft/testing';
import { textureChanges } from './textureChanges';

describe('textureChanges', () => {
  it('reports painted, undone, renamed, added and removed textures', async () => {
    const t = await minecraftApp({}, { imaging: createImagingService() });
    const data = toBase64(await encodePng(new Uint8ClampedArray(16 * 16 * 4), 16, 16));
    const start = t.app();
    const { id } = await t.run('texture.add', { name: 'stone', mimeType: 'image/png', data, width: 16, height: 16 });
    const added = t.app();
    expect(textureChanges(start, added)).toMatchObject([{ textureId: id, before: undefined, pixels: true }]);

    await t.run('paint.pixel_stroke', { textureId: id, points: [[1, 1]], color: '#ff0000' });
    const painted = t.app();
    const [change] = textureChanges(added, painted);
    expect(change).toMatchObject({ docId: painted.activeDocId, textureId: id, pixels: true });
    expect(change.after!.data).not.toBe(change.before!.data);

    await t.run('history.undo');
    expect(textureChanges(painted, t.app())).toMatchObject([{ textureId: id, pixels: true }]);

    const beforeRename = t.app();
    await t.run('texture.rename', { id, name: 'cobble' });
    expect(textureChanges(beforeRename, t.app())).toMatchObject([{ textureId: id, pixels: false }]);

    // Nothing changed: nothing reported.
    expect(textureChanges(t.app(), t.app())).toEqual([]);
  });
});
