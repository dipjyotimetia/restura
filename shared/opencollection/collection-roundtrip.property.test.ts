import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Collection, HttpRequest } from '../types';
import { internalToOC } from './from-internal';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from './serializer';
import { ocToInternal } from './to-internal';

const runs = { numRuns: 40 };
const text = fc.string({ minLength: 1, maxLength: 24, unit: 'grapheme' });
const method = fc.constantFrom('GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD') as fc.Arbitrary<
  HttpRequest['method']
>;

const httpRequest: fc.Arbitrary<HttpRequest> = fc.record({
  id: text,
  name: text,
  type: fc.constant('http' as const),
  method,
  url: fc
    .tuple(
      fc.constantFrom('https://example.test', 'https://api.example.test'),
      fc.stringMatching(/^[a-z0-9]{0,12}$/)
    )
    .map(([origin, path]) => `${origin}/${path}`),
  headers: fc.array(
    fc.record({
      id: text,
      key: fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,12}$/),
      value: fc.string({ maxLength: 20, unit: 'grapheme' }),
      enabled: fc.boolean(),
    }),
    { maxLength: 3 }
  ),
  params: fc.constant([]),
  body: fc.oneof(
    fc.constant({ type: 'none' as const }),
    text.map((raw) => ({ type: 'text' as const, raw }))
  ),
  auth: fc.constant({ type: 'none' as const }),
});

const collection: fc.Arbitrary<Collection> = fc.record({
  id: text,
  name: text,
  description: fc.option(text, { nil: undefined }),
  auth: fc.constant({ type: 'none' as const }),
  variables: fc.constant([]),
  items: fc.array(
    fc.record({
      id: text,
      name: text,
      type: fc.constant('request' as const),
      request: httpRequest,
    }),
    { minLength: 1, maxLength: 3 }
  ),
});

/** Fields the OpenCollection bridge claims to keep for a plain HTTP request. */
function project(value: Collection) {
  return {
    name: value.name,
    auth: value.auth?.type ?? 'none',
    items: value.items.map((item) => {
      const request = item.request;
      if (request?.type !== 'http') return { name: item.name, request: null };
      return {
        name: item.name,
        request: {
          name: request.name,
          method: request.method,
          url: request.url,
          headers: request.headers
            .filter((header) => header.enabled)
            .map((header) => [header.key, header.value]),
          body: request.body.type === 'text' ? (request.body.raw ?? '') : request.body.type,
          auth: request.auth?.type,
        },
      };
    }),
  };
}

describe('OpenCollection round-trip properties', () => {
  it('YAML parse/serialize is idempotent, and a second internal conversion changes nothing', () => {
    fc.assert(
      fc.property(collection, (input) => {
        const document = internalToOC(input);
        const parsed = parseOpenCollectionYAML(serializeOpenCollectionYAML(document));
        const reparsed = parseOpenCollectionYAML(serializeOpenCollectionYAML(parsed));
        expect(reparsed).toEqual(parsed);

        const once = ocToInternal(parsed);
        const twice = ocToInternal(internalToOC(once));
        expect(project(twice)).toEqual(project(once));
        expect(project(once).name).toBe(input.name);
        expect(project(once).items.map((item) => item.name)).toEqual(
          input.items.map((item) => item.name)
        );
      }),
      runs
    );
  });
});
