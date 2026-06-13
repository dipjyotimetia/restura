// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { valueToString, parseSchemaJson, isConfluentEncoded } from '../kafka-serde';

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

describe('parseSchemaJson', () => {
  it('parses a JSON object', () => {
    expect(parseSchemaJson('{"id":1,"name":"a"}')).toEqual({ value: { id: 1, name: 'a' } });
  });

  it('parses a JSON scalar (e.g. an Avro string schema)', () => {
    expect(parseSchemaJson('"hello"')).toEqual({ value: 'hello' });
  });

  it('errors on a non-JSON value (default field label)', () => {
    expect(parseSchemaJson('not json')).toEqual({
      error: 'Schema-encoded value must be valid JSON.',
    });
  });

  it('shapes the error message by field', () => {
    expect(parseSchemaJson('not json', 'key')).toEqual({
      error: 'Schema-encoded key must be valid JSON.',
    });
  });
});

describe('isConfluentEncoded', () => {
  it('is true for the Confluent wire framing (magic byte 0x00 + 4-byte id)', () => {
    // 0x00 magic + schema id 2 + a byte of payload.
    expect(isConfluentEncoded(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x42]))).toBe(true);
  });

  it('is false for plain UTF-8 bytes', () => {
    expect(isConfluentEncoded(Buffer.from('hello', 'utf-8'))).toBe(false);
  });

  it('is false for a buffer shorter than the 5-byte header', () => {
    expect(isConfluentEncoded(Buffer.from([0x00, 0x00]))).toBe(false);
  });
});
