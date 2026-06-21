import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { exportToOpenCollection } from '../exporters';
import { importOpenCollection } from '../importers/opencollection';

const FIXTURES = 'tests/fixtures/opencollection';

describe('exportToOpenCollection', () => {
  it('roundtrips simple-http via importer → exporter → importer', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const original = importOpenCollection(yaml.load(raw));
    const yamlOut = exportToOpenCollection(original.collection);
    expect(yamlOut).toContain('opencollection');
    expect(yamlOut).toContain('Simple HTTP Demo');
    const reimported = importOpenCollection(yaml.load(yamlOut));
    expect(reimported.collection.items.map((i) => i.name)).toEqual(
      original.collection.items.map((i) => i.name)
    );
  });

  it('preserves SSE extensions in exported YAML', () => {
    const raw = readFileSync(`${FIXTURES}/multi-protocol.yaml`, 'utf8');
    const original = importOpenCollection(yaml.load(raw));
    const yamlOut = exportToOpenCollection(original.collection);
    expect(yamlOut).toContain('x-restura-sse');
  });
});
