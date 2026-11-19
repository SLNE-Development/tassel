import { describe, expect, it } from 'vitest';
import { formatPropertyValue, freeKey, parseOptionalNumber, parsePropertyValue, parseTags } from './propertyValue';

describe('parsePropertyValue', () => {
  it('reads booleans, numbers and strings', () => {
    expect(parsePropertyValue('true')).toBe(true);
    expect(parsePropertyValue(' false ')).toBe(false);
    expect(parsePropertyValue('12')).toBe(12);
    expect(parsePropertyValue('-0.5')).toBe(-0.5);
    expect(parsePropertyValue('1e3')).toBe(1000);
    expect(parsePropertyValue('fast')).toBe('fast');
    expect(parsePropertyValue('1.2.3')).toBe('1.2.3');
    expect(parsePropertyValue('')).toBe('');
  });
  it('keeps quoted text a string', () => {
    expect(parsePropertyValue('"12"')).toBe('12');
    expect(parsePropertyValue('"true"')).toBe('true');
  });
  it('round-trips every value', () => {
    for (const value of [true, false, 0, 3.5, -2, 'a', '', '12', 'true', ' x', '"q"']) expect(parsePropertyValue(formatPropertyValue(value))).toBe(value);
  });
});

describe('helpers', () => {
  it('finds a free key', () => {
    expect(freeKey(['a'], 'property')).toBe('property');
    expect(freeKey(['property', 'property_2'], 'property')).toBe('property_3');
  });
  it('splits tags', () => {
    expect(parseTags(' fast, mymod:hot ,,fast')).toEqual(['fast', 'mymod:hot']);
  });
  it('parses optional numbers', () => {
    expect(parseOptionalNumber('')).toBeNull();
    expect(parseOptionalNumber('1,5')).toBe(1.5);
    expect(parseOptionalNumber('abc')).toBeUndefined();
  });
});
