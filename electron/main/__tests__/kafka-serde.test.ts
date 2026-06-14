// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  valueToString,
  parseSchemaJson,
  isConfluentEncoded,
  encodeSchemaField,
  decodeField,
} from '../handlers/kafka-serde';

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

describe('encodeSchemaField', () => {
  const okRegistry = {
    encode: async (id: number, payload: unknown) =>
      Buffer.from(`enc:${id}:${JSON.stringify(payload)}`),
  };

  it('parses JSON and encodes with the schema id', async () => {
    const r = await encodeSchemaField(okRegistry, 7, '{"id":1}', 'value');
    expect(r).toEqual({ value: Buffer.from('enc:7:{"id":1}') });
  });

  it('errors on non-JSON input (field-shaped message)', async () => {
    expect(await encodeSchemaField(okRegistry, 7, 'nope', 'key')).toEqual({
      error: 'Schema-encoded key must be valid JSON.',
    });
  });

  it('wraps a registry encode failure with the field label', async () => {
    const badRegistry = {
      encode: async () => {
        throw new Error('schema 9 not found');
      },
    };
    expect(await encodeSchemaField(badRegistry, 9, '{"a":1}', 'value')).toEqual({
      error: 'Value schema encode failed: schema 9 not found',
    });
  });
});

describe('decodeField', () => {
  const registry = { decode: async (_buf: Buffer) => ({ decoded: true }) };

  it('registry-decodes a Confluent-framed buffer to its JSON string', async () => {
    const framed = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x42]);
    expect(await decodeField(registry, framed)).toBe('{"decoded":true}');
  });

  it('reads a plain buffer as UTF-8 (no registry)', async () => {
    expect(await decodeField(undefined, Buffer.from('hello', 'utf-8'))).toBe('hello');
  });

  it('passes a non-framed buffer through as text even with a registry', async () => {
    expect(await decodeField(registry, Buffer.from('plain', 'utf-8'))).toBe('plain');
  });

  it('falls back to raw text when decode throws (schema missing)', async () => {
    const failing = {
      decode: async () => {
        throw new Error('schema missing');
      },
    };
    const framed = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x68, 0x69]);
    // Falls back to the UTF-8 reading of the framed bytes (best-effort display).
    expect(await decodeField(failing, framed)).toBe(framed.toString('utf-8'));
  });
});
