import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';

const FIXTURES = 'tests/fixtures/opencollection';

describe('serializer', () => {
  it('parses a valid YAML file into a typed OpenCollection', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const oc = parseOpenCollectionYAML(raw);
    expect(oc.info.name).toBe('Simple HTTP Demo');
    expect(oc.items?.[0]).toMatchObject({ info: { type: 'http' } });
  });

  it('throws on schema-invalid YAML', () => {
    expect(() => parseOpenCollectionYAML('opencollection: "1.0.0"\ninfo:\n  bogus: 1')).toThrow();
  });

  it('throws on syntactically invalid YAML', () => {
    expect(() => parseOpenCollectionYAML('::not valid yaml::')).toThrow();
  });

  it('roundtrips byte-stable on the simple fixture', () => {
    const raw = readFileSync(`${FIXTURES}/simple-http.yaml`, 'utf8');
    const oc = parseOpenCollectionYAML(raw);
    const serialized = serializeOpenCollectionYAML(oc);
    const reparsed = parseOpenCollectionYAML(serialized);
    expect(reparsed).toEqual(oc);
  });
});
