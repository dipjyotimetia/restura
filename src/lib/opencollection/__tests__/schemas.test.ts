import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { openCollectionSchema } from '../schemas';

const FIXTURES = 'tests/fixtures/opencollection';

describe('openCollectionSchema', () => {
  it('parses simple-http.yaml', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const parsed = yaml.load(raw);
    const result = openCollectionSchema.safeParse(parsed);
    if (!result.success) console.error(result.error.format());
    expect(result.success).toBe(true);
  });

  it('parses multi-protocol.yaml including SSE in extensions', () => {
    const raw = readFileSync(`${FIXTURES}/multi-protocol.yaml`, 'utf8');
    const parsed = yaml.load(raw);
    const result = openCollectionSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it('rejects a collection without info.name', () => {
    const result = openCollectionSchema.safeParse({ opencollection: '1.0.0', info: {} });
    expect(result.success).toBe(false);
  });

  it('accepts unknown fields in extensions', () => {
    const result = openCollectionSchema.safeParse({
      opencollection: '1.0.0',
      info: { name: 'X' },
      extensions: { 'x-restura-anything': { foo: 'bar' } },
    });
    expect(result.success).toBe(true);
  });
});
