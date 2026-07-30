import { readFileSync } from 'node:fs';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
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

  it('roundtrips collection-owned environment hierarchy without private values', () => {
    const collection = {
      id: 'collection-1',
      name: 'Hierarchy',
      items: [],
      variables: [
        {
          id: 'collection-private',
          key: 'COLLECTION_SECRET',
          value: 'nope',
          enabled: true,
          private: true,
        },
      ],
    };
    const yamlOut = exportToOpenCollection(collection, [
      {
        id: 'base',
        name: 'Base',
        collectionId: 'collection-1',
        variables: [{ id: 'base-var', key: 'HOST', value: 'https://api.example', enabled: true }],
      },
      {
        id: 'child',
        name: 'Child',
        collectionId: 'collection-1',
        parentId: 'base',
        variables: [
          { id: 'child-private', key: 'TOKEN', value: 'nope', enabled: true, private: true },
        ],
      },
    ]);
    expect(yamlOut).toContain('extends: "Base"');
    expect(yamlOut).not.toContain('nope');
    const imported = importOpenCollection(yaml.load(yamlOut));
    const environments = imported.environments ?? [];
    const base = environments.find((environment) => environment.name === 'Base');
    const child = environments.find((environment) => environment.name === 'Child');
    expect(child).toMatchObject({ parentId: base?.id });
    expect(child?.variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'TOKEN', private: true, value: '' })])
    );
  });
});
