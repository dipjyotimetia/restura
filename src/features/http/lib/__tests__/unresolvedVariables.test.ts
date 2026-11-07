import { describe, expect, it } from 'vitest';
import type { HttpRequest } from '@/types';
import { findUnresolvedVariables } from '../unresolvedVariables';

const known = new Set(['base', 'token']);
const getStatus = (name: string): 'resolved' | 'unresolved' =>
  known.has(name) ? 'resolved' : 'unresolved';

const base: HttpRequest = {
  id: 'r',
  name: 'r',
  type: 'http',
  method: 'POST',
  url: '{{base}}/x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

describe('findUnresolvedVariables', () => {
  it('returns nothing when every reference resolves', () => {
    expect(findUnresolvedVariables(base, getStatus)).toEqual([]);
  });

  it('collects unresolved names across URL, params, path vars, headers, body and auth', () => {
    const request: HttpRequest = {
      ...base,
      url: '{{base}}/{{missingPath}}',
      params: [
        { id: 'p1', key: 'q', value: '{{inParam}}', enabled: true },
        { id: 'p2', key: 'off', value: '{{disabledParam}}', enabled: false },
      ],
      pathVariables: [{ id: 'pv', key: 'id', value: '{{inPathVar}}', enabled: true }],
      headers: [{ id: 'h1', key: 'X-{{inHeaderKey}}', value: '{{token}}', enabled: true }],
      body: { type: 'json', raw: '{"a":"{{inBody}}","b":"{{inParam}}"}' },
      auth: { type: 'bearer', bearer: { token: '{{inAuth}}' } } as HttpRequest['auth'],
    };
    expect(findUnresolvedVariables(request, getStatus)).toEqual([
      'missingPath',
      'inParam',
      'inPathVar',
      'inHeaderKey',
      'inBody',
      'inAuth',
    ]);
  });

  it('reads form-data / urlencoded fields (text only), not the stale raw text', () => {
    const request: HttpRequest = {
      ...base,
      body: {
        type: 'form-data',
        raw: '{{staleRaw}}',
        formData: [
          { id: 'f1', key: 'a', value: '{{inForm}}', enabled: true, type: 'text' },
          { id: 'f2', key: 'f', value: '{{notAFile}}', enabled: true, type: 'file' },
          { id: 'f3', key: 'c', value: '{{offForm}}', enabled: false, type: 'text' },
        ],
      },
    };
    expect(findUnresolvedVariables(request, getStatus)).toEqual(['inForm']);
    expect(
      findUnresolvedVariables(
        { ...request, body: { ...request.body, type: 'x-www-form-urlencoded' } },
        getStatus
      )
    ).toEqual(['inForm']);
  });

  it('reads GraphQL variables and skips binary bodies', () => {
    expect(
      findUnresolvedVariables(
        {
          ...base,
          body: { type: 'graphql', raw: '{ a }', graphqlVariables: '{"v":"{{gqlVar}}"}' },
        },
        getStatus
      )
    ).toEqual(['gqlVar']);
    expect(
      findUnresolvedVariables({ ...base, body: { type: 'binary', raw: '{{b64}}' } }, getStatus)
    ).toEqual([]);
  });

  it('ignores text that does not read as a variable', () => {
    expect(
      findUnresolvedVariables(
        { ...base, body: { type: 'text', raw: '{{ not a var! }}' } },
        getStatus
      )
    ).toEqual([]);
  });

  it('skips disabled path variables and headers', () => {
    expect(
      findUnresolvedVariables(
        {
          ...base,
          pathVariables: [{ id: 'pv', key: 'id', value: '{{offPath}}', enabled: false }],
          headers: [{ id: 'h', key: '{{offKey}}', value: '{{offHeader}}', enabled: false }],
        },
        getStatus
      )
    ).toEqual([]);
  });

  it('tolerates bodies with missing text or fields', () => {
    for (const body of [
      { type: 'json' },
      { type: 'graphql' },
      { type: 'form-data' },
      { type: 'x-www-form-urlencoded' },
    ] as const) {
      expect(findUnresolvedVariables({ ...base, body }, getStatus)).toEqual([]);
    }
  });

  it('walks nested auth arrays and objects, skipping nulls and over-deep values', () => {
    const tooDeep = { a: { b: { c: { d: { e: { f: { g: '{{tooDeep}}' } } } } } } };
    const request = {
      ...base,
      auth: {
        type: 'oauth2',
        oauth2: {
          clientId: '{{inClient}}',
          scopes: ['{{inScope}}', null, 3],
          extra: { nested: '{{inNested}}', missing: undefined },
          tooDeep,
        },
      },
    } as unknown as HttpRequest;
    expect(findUnresolvedVariables(request, getStatus)).toEqual([
      'inClient',
      'inScope',
      'inNested',
    ]);
  });

  it('ignores auth types without config fields and stale configs of other types', () => {
    const request = {
      ...base,
      auth: { type: 'none', bearer: { token: '{{staleBearer}}' } },
    } as unknown as HttpRequest;
    expect(findUnresolvedVariables(request, getStatus)).toEqual([]);
  });
});
