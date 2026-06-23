import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { assertBoundedDocument, openCollectionSchema } from '../schemas';

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

describe('assertBoundedDocument', () => {
  it('accepts a normally-nested document', () => {
    const doc = {
      opencollection: '1.0.0',
      info: { name: 'X' },
      items: [{ info: { name: 'folder' }, items: [{ http: { method: 'GET', url: 'https://x' } }] }],
    };
    expect(() => assertBoundedDocument(doc)).not.toThrow();
  });

  it('rejects a document nested past the depth limit', () => {
    // Build a chain of nested folders deeper than the default cap of 100.
    let node: Record<string, unknown> = { info: { name: 'leaf' } };
    for (let i = 0; i < 300; i++) node = { info: { name: `f${i}` }, items: [node] };
    expect(() => assertBoundedDocument(node)).toThrow(/depth/i);
  });

  it('rejects a document past the node-count limit', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ info: { name: `r${i}` } }));
    expect(() => assertBoundedDocument({ items }, { maxNodes: 10 })).toThrow(/nodes/i);
  });
});
