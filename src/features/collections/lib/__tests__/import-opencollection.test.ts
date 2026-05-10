import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { importOpenCollection } from '../importers/opencollection';

const FIXTURES = 'tests/fixtures/opencollection';

describe('importOpenCollection', () => {
  it('imports a parsed bundled OpenCollection document', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const data = yaml.load(raw);
    const collection = importOpenCollection(data);
    expect(collection.name).toBe('Simple HTTP Demo');
    expect(collection.items.length).toBe(1);
    expect(collection.items[0]?.type).toBe('request');
  });

  it('throws a readable error on invalid input', () => {
    expect(() => importOpenCollection({ opencollection: '1.0.0', info: {} })).toThrow(
      /Invalid OpenCollection document/,
    );
  });

  it('imports the multi-protocol fixture and surfaces SSE from extensions', () => {
    const raw = readFileSync(`${FIXTURES}/multi-protocol.yaml`, 'utf8');
    const data = yaml.load(raw);
    const collection = importOpenCollection(data);
    const types = collection.items.map((i) => i.request?.type ?? `folder:${i.name}`);
    expect(types).toContain('http');
    expect(types).toContain('grpc');
    expect(types).toContain('sse');
  });
});
