import { describe, expect, it, vi } from 'vitest';
import type { BodyType, FormDataItem } from '../types';
import {
  appendQueryPairs,
  applyBodyDefaultHeaders,
  buildAuthCredential,
  buildProxyBody,
  buildProxyFormFields,
  type CredentialHost,
  collectEnabledHeaders,
  collectEnabledRowPairs,
  collectEnabledRows,
  DEFERRED_SECRET,
  isSendableRow,
  mapProxyBodyType,
} from './request-spec';

const row = (key: string, value: string, enabled: boolean, type: 'text' | 'file' = 'text') =>
  ({ id: key, key, value, enabled, type }) as FormDataItem;

const host: CredentialHost = {
  readSecret: (value) => {
    if (typeof value === 'object' && value?.kind === 'handle') return DEFERRED_SECRET;
    return typeof value === 'object' && value?.kind === 'inline' ? value.value : (value as string);
  },
  encodeBasic: (credentials) => `b64(${credentials})`,
};

describe('appendQueryPairs', () => {
  it('escapes braces so an unresolved {{var}} goes out encoded, as Newman sends it', () => {
    expect(appendQueryPairs('https://x.test/r', [['only', '{{only}}']])).toBe(
      'https://x.test/r?only=%7B%7Bonly%7D%7D'
    );
  });

  it('keeps +, existing escapes and : , / as typed', () => {
    expect(appendQueryPairs('https://x.test/r', [['q', 'a+b%2Bc:d,e/f']])).toBe(
      'https://x.test/r?q=a+b%2Bc:d,e/f'
    );
  });
});

describe('rows', () => {
  it('sends a row only when enabled is truthy and it has a key', () => {
    expect(isSendableRow({ enabled: true, key: 'a' })).toBe(true);
    expect(isSendableRow({ enabled: false, key: 'a' })).toBe(false);
    expect(isSendableRow({ enabled: true, key: '' })).toBe(false);
    expect(isSendableRow({ key: 'a' })).toBe(false);
  });

  it('collects sendable rows through the host value hook', () => {
    expect(
      collectEnabledRows(
        [
          { key: 'a', value: '1', enabled: true },
          { key: 'b', value: '2', enabled: false },
        ],
        (r) => `<${r.value}>`
      )
    ).toEqual({ a: '<1>' });
  });
});

describe('mapProxyBodyType', () => {
  const TABLE: ReadonlyArray<[BodyType, string]> = [
    ['none', 'none'],
    ['json', 'json'],
    ['text', 'text'],
    ['form-data', 'form-data'],
    ['binary', 'binary'],
    ['x-www-form-urlencoded', 'form-urlencoded'],
    ['graphql', 'json'],
    ['xml', 'raw'],
    ['protobuf', 'raw'],
    ['multipart-mixed', 'raw'],
  ];
  for (const [input, output] of TABLE) {
    it(`${input} -> ${output}`, () => expect(mapProxyBodyType(input)).toBe(output));
  }

  it('fails loudly on an unknown type instead of sending nothing', () => {
    expect(() => mapProxyBodyType('yaml' as BodyType)).toThrow('Unmapped body type');
  });
});

describe('buildProxyFormFields', () => {
  it('leaves file bytes alone and fills multipart defaults', () => {
    expect(
      buildProxyFormFields([row('t', 'v', true), row('f', 'AA==', true, 'file')], {
        resolveValue: (text) => `r(${text})`,
      })
    ).toEqual([
      { name: 't', value: 'r(v)' },
      {
        name: 'f',
        value: 'AA==',
        filename: 'file',
        contentType: 'application/octet-stream',
      },
    ]);
  });

  it('never resolves a disabled row, so policy hooks cannot trip on it', () => {
    const resolveValue = vi.fn((text: string) => text);
    buildProxyFormFields([row('off', '{{x}}', false)], { resolveValue });
    expect(resolveValue).not.toHaveBeenCalled();
  });

  it('resolves a name only when the host asks', () => {
    const items = [row('{{k}}', 'v', true)];
    expect(buildProxyFormFields(items)[0]?.name).toBe('{{k}}');
    expect(buildProxyFormFields(items, { resolveName: () => 'K' })[0]?.name).toBe('K');
  });
});

describe('buildProxyBody', () => {
  const resolve = (text: string) => text.replace('{{x}}', 'X');

  it('resolves raw text exactly once', () => {
    const counted = vi.fn(resolve);
    expect(buildProxyBody({ type: 'json', raw: '{{x}}' }, { resolve: counted })).toEqual({
      bodyType: 'json',
      data: 'X',
    });
    expect(counted).toHaveBeenCalledTimes(1);
  });

  it('does not touch a body it will not send', () => {
    const counted = vi.fn(resolve);
    expect(buildProxyBody(undefined, { resolve: counted })).toEqual({ bodyType: 'none' });
    expect(buildProxyBody({ type: 'none', raw: '{{x}}' }, { resolve: counted })).toEqual({
      bodyType: 'none',
    });
    expect(counted).not.toHaveBeenCalled();
  });

  it('keeps binary bytes verbatim unless the host opts in', () => {
    const body = { type: 'binary', raw: '{{x}}' } as const;
    expect(buildProxyBody(body, { resolve }).data).toBe('{{x}}');
    expect(buildProxyBody(body, { resolve, resolveBinary: resolve }).data).toBe('X');
  });

  it('prefers urlencoded rows, falls back to raw, and drops file parts', () => {
    expect(
      buildProxyBody(
        {
          type: 'x-www-form-urlencoded',
          raw: 'raw',
          formData: [row('a', '{{x}}', true), row('f', 'x', true, 'file')],
        },
        { resolve }
      )
    ).toEqual({ bodyType: 'form-urlencoded', formData: [{ name: 'a', value: 'X' }] });
    expect(buildProxyBody({ type: 'x-www-form-urlencoded', raw: '{{x}}' }, { resolve })).toEqual({
      bodyType: 'form-urlencoded',
      data: 'X',
    });
  });

  it('never sends raw for multipart', () => {
    expect(buildProxyBody({ type: 'form-data', raw: 'raw' }, { resolve })).toEqual({
      bodyType: 'form-data',
    });
  });

  it('omits data when there is no raw', () => {
    expect(buildProxyBody({ type: 'protobuf' }, { resolve })).toEqual({ bodyType: 'raw' });
  });
});

describe('applyBodyDefaultHeaders', () => {
  it('defaults XML unless any casing of Content-Type is set', () => {
    expect(applyBodyDefaultHeaders('xml', {})).toEqual({ 'Content-Type': 'application/xml' });
    expect(applyBodyDefaultHeaders('xml', { 'content-type': 'text/xml' })).toEqual({
      'content-type': 'text/xml',
    });
    expect(applyBodyDefaultHeaders('json', {})).toEqual({});
  });
});

describe('buildAuthCredential', () => {
  it('returns nothing for no auth and for sign-at-wire schemes', () => {
    const empty = { headers: {}, params: {} };
    expect(buildAuthCredential(undefined, host)).toEqual(empty);
    expect(buildAuthCredential({ type: 'none' }, host)).toEqual(empty);
    for (const auth of [
      { type: 'digest', digest: { username: 'u', password: 'p' } },
      { type: 'wsse', wsse: { username: 'u', password: 'p' } },
      { type: 'ntlm', ntlm: { username: 'u', password: 'p' } },
    ] as const) {
      expect(buildAuthCredential(auth, host)).toEqual(empty);
    }
  });

  it('defers instead of reading when the host says the secret is not readable here', () => {
    const handle = { kind: 'handle', id: 'h' } as const;
    for (const auth of [
      { type: 'bearer', bearer: { token: handle } },
      { type: 'basic', basic: { username: '', password: handle } },
      { type: 'api-key', apiKey: { key: 'k', value: handle, in: 'header' } },
      { type: 'oauth2', oauth2: { accessToken: handle } },
    ] as const) {
      expect(buildAuthCredential(auth, host)).toEqual({
        headers: {},
        params: {},
        requiresMainSideApply: true,
      });
    }
  });

  it('applies the gRPC options', () => {
    const options = { headerCase: 'lower', basicRequiresPassword: true } as const;
    expect(
      buildAuthCredential({ type: 'bearer', bearer: { token: 't' } }, host, options).headers
    ).toEqual({ authorization: 'Bearer t' });
    expect(
      buildAuthCredential(
        { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'header' } },
        host,
        options
      ).headers
    ).toEqual({ 'x-key': 'v' });
    expect(
      buildAuthCredential({ type: 'basic', basic: { username: 'u', password: '' } }, host, options)
        .headers
    ).toEqual({});
  });

  it('encodes Basic through the host', () => {
    expect(
      buildAuthCredential({ type: 'basic', basic: { username: 'u', password: 'p' } }, host).headers
    ).toEqual({ Authorization: 'Basic b64(u:p)' });
  });
});

describe('request-spec edge cases', () => {
  const kv = (key: string, value: string, enabled = true) => ({ key, value, enabled });

  it('collectEnabledRowPairs keeps repeated keys in order and skips unsendable rows', () => {
    expect(
      collectEnabledRowPairs(
        [kv('a', '1'), kv('b', 'x', false), kv('', 'blank'), kv('a', '2')],
        (r) => r.value
      )
    ).toEqual([
      ['a', '1'],
      ['a', '2'],
    ]);
  });

  it('collectEnabledHeaders: an empty repeated value neither adds a joiner nor erases the prior one', () => {
    expect(
      collectEnabledHeaders([kv('X-A', ''), kv('x-a', 'v'), kv('X-A', '')], (r) => r.value)
    ).toEqual({ 'X-A': 'v' });
    expect(
      collectEnabledHeaders([kv('Cookie', 'a=1'), kv('cookie', 'b=2')], (r) => r.value)
    ).toEqual({ Cookie: 'a=1; b=2' });
  });

  it('appendQueryPairs adds no extra separator after a trailing ? or &', () => {
    expect(appendQueryPairs('https://x.test/r?', [['a', '1']])).toBe('https://x.test/r?a=1');
    expect(appendQueryPairs('https://x.test/r?x=1&', [['a', '1']])).toBe(
      'https://x.test/r?x=1&a=1'
    );
  });

  it('basic auth with a username and no password encodes an empty password', () => {
    expect(buildAuthCredential({ type: 'basic', basic: { username: 'u' } } as never, host)).toEqual(
      { headers: { Authorization: 'Basic b64(u:)' }, params: {} }
    );
  });
});
