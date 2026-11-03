import { describe, expect, it } from 'vitest';
import { readKey, withKey, writeKey } from './object-keys';

describe('object-keys', () => {
  it('reads a runtime key, undefined when absent', () => {
    const value = { a: 1 };
    expect(readKey(value, 'a')).toBe(1);
    expect(readKey(value, 'b')).toBeUndefined();
  });

  it('writes a runtime key in place', () => {
    const value: { a: number } = { a: 1 };
    writeKey(value, 'b', 'two');
    expect(value).toEqual({ a: 1, b: 'two' });
  });

  it('throws like a strict-mode assignment on a frozen object', () => {
    expect(() => writeKey(Object.freeze({ a: 1 }), 'a', 2)).toThrow(TypeError);
  });

  it('copies before writing and leaves the source alone', () => {
    const source = { a: 1, b: 2 };
    const next = withKey(source, 'b', 3);
    expect(next).toEqual({ a: 1, b: 3 });
    expect(next).not.toBe(source);
    expect(source).toEqual({ a: 1, b: 2 });
  });
});
