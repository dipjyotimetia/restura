// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { valueToString } from '../kafka-serde';

describe('valueToString', () => {
  it('passes a plain string through unchanged (string consumer path)', () => {
    expect(valueToString('hello')).toBe('hello');
    expect(valueToString('')).toBe('');
  });

  it('JSON-serializes a registry-decoded object (Avro/Protobuf/JSON path)', () => {
    expect(valueToString({ id: 1, name: 'a' })).toBe('{"id":1,"name":"a"}');
    expect(valueToString([1, 2, 3])).toBe('[1,2,3]');
  });

  it('decodes a Buffer / Uint8Array to utf-8 text', () => {
    expect(valueToString(Buffer.from('raw bytes'))).toBe('raw bytes');
    expect(valueToString(new TextEncoder().encode('uint8'))).toBe('uint8');
  });

  it('maps null / undefined to an empty string', () => {
    expect(valueToString(null)).toBe('');
    expect(valueToString(undefined)).toBe('');
  });

  it('stringifies primitives that are not strings', () => {
    expect(valueToString(42)).toBe('42');
    expect(valueToString(true)).toBe('true');
  });
});
