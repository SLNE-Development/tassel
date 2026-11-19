import { describe, expect, it } from 'vitest';
import { parsePalette, serializePalette } from './palette';

describe('parsePalette', () => {
  it('reads GIMP palettes with a name', () => {
    const text = 'GIMP Palette\nName: Sweet\nColumns: 4\n#\n255   0   0 Red\n  0 128 255\n';
    expect(parsePalette(text)).toEqual({ name: 'Sweet', colors: ['#ff0000', '#0080ff'] });
  });

  it('reads Paint.NET files (AARRGGBB, comments)', () => {
    const text = '; paint.net Palette File\n; comment\nFFFF0000\r\n80001122\n';
    expect(parsePalette(text).colors).toEqual(['#ff0000', '#001122']);
  });

  it('reads plain hex lines, with or without #, and drops duplicates', () => {
    expect(parsePalette('ff0000\n#00FF00\n#0f0\nFF0000\n\n').colors).toEqual(['#ff0000', '#00ff00']);
  });

  it('rejects files without colours', () => {
    expect(() => parsePalette('hello\nworld')).toThrow();
    expect(() => parsePalette('GIMP Palette\nName: x\n')).toThrow();
  });
});

describe('serializePalette', () => {
  const colors = ['#ff0000', '#0080ff'];
  it('round-trips every format', () => {
    for (const format of ['gpl', 'txt', 'hex'] as const) {
      expect(parsePalette(serializePalette(colors, format, 'Test')).colors, format).toEqual(colors);
    }
  });
  it('keeps the name in GIMP files', () => {
    expect(parsePalette(serializePalette(colors, 'gpl', 'Mine')).name).toBe('Mine');
  });
});
