import { describe, expect, it } from 'vitest';
import { arrowSegments, openingCorners, portFrame } from './factoryOverlay';

const frame = (face: 'north' | 'east' | 'up' | null, position: [number, number, number] = [8, 8, 8]) => portFrame({ face, position, size: [6, 4] });

describe('factory port markers', () => {
  it('puts the centre of the block at the world origin column', () => {
    expect(frame('north').centre).toEqual([0, 0.5, 0]);
  });

  it('spans the opening on the face plane', () => {
    // East wall: width along Z, height along Y.
    const corners = openingCorners(frame('east'));
    expect(new Set(corners.map((c) => c[0])).size).toBe(1);
    expect(Math.max(...corners.map((c) => c[2])) - Math.min(...corners.map((c) => c[2]))).toBeCloseTo(6 / 16);
    expect(Math.max(...corners.map((c) => c[1])) - Math.min(...corners.map((c) => c[1]))).toBeCloseTo(4 / 16);
    // Floor and ceiling: width along X, height along Z.
    const top = openingCorners(frame('up'));
    expect(new Set(top.map((c) => c[1])).size).toBe(1);
  });

  it('points an output arrow out of the block and an input arrow into it', () => {
    const out = arrowSegments(frame('north'), 'output');
    const into = arrowSegments(frame('north'), 'input');
    // The shaft runs from the opening (z = 0) to the tip, which lies outside (north = -Z).
    expect(out[1][2]).toBeLessThan(0);
    // The head of an output sits at the tip, of an input at the opening.
    expect(out[2]).toEqual(out[1]);
    expect(into[2]).toEqual(into[0]);
  });

  it('draws two heads for a bidirectional port', () => {
    expect(arrowSegments(frame('east'), 'bidirectional')).toHaveLength(2 + 16);
    expect(arrowSegments(frame('east'), 'output')).toHaveLength(2 + 8);
  });
});
