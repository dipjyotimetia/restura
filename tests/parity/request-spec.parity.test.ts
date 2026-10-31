// @vitest-environment node
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher, FetcherRequest } from '@shared/protocol/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One table run through both hosts' real entry points, compared on the wire: the
 * renderer's `executeRequest` spec and the CLI's `executeHttp` spec both pass
 * through `executeHttpProxy` into a capturing Fetcher.
 */
const proxied = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

import { executeHttp } from '../../cli/src/runner/executors/http';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { useEnvironmentStore } from '../../src/store/useEnvironmentStore';
import { useGlobalsStore } from '../../src/store/useGlobalsStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import type { HttpRequest } from '../../src/types';

const URL_BASE = 'https://api.example.com/x';
const VARS = { who: 'ada', tok: 'T0K' };

interface Wire {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

async function normalizeBody(body: FetcherRequest['body']): Promise<unknown> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return { bytes: new TextDecoder().decode(body) };
  if (body instanceof FormData) {
    const parts: unknown[] = [];
    for (const [name, value] of body.entries()) {
      parts.push(
        typeof value === 'string'
          ? { name, value }
          : { name, filename: value.name, type: value.type, text: await value.text() }
      );
    }
    return parts;
  }
  return String(body);
}

function capturing(sink: Wire[]): Fetcher {
  return async (req) => {
    sink.push({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(
        Object.entries(req.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
      ),
      body: await normalizeBody(req.body),
    });
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: '0',
    };
  };
}

async function viaRenderer(request: HttpRequest): Promise<Wire | undefined> {
  const wire: Wire[] = [];
  proxied.mockReset();
  proxied.mockImplementation(async (spec) => {
    const result = await executeHttpProxy(spec, capturing(wire), { allowLocalhost: true });
    if (!result.ok) throw new Error(result.payload.error);
    return { status: 200, statusText: 'OK', headers: {}, data: '', size: 0 };
  });
  await executeRequest({
    request,
    envVars: { ...VARS },
    globalSettings: useSettingsStore.getState().settings,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
  });
  return wire[0];
}

async function viaCli(request: HttpRequest): Promise<Wire | undefined> {
  const wire: Wire[] = [];
  const outcome = await executeHttp(
    { relativePath: 'r', folderPath: [], type: 'http', request },
    { vars: { ...VARS }, timeoutMs: 5000, allowLocalhost: true, fetcher: capturing(wire) }
  );
  if (outcome.errorMessage) throw new Error(outcome.errorMessage);
  return wire[0];
}

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'POST',
    url: URL_BASE,
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const row = (key: string, value: string, enabled?: boolean, type: 'text' | 'file' = 'text') =>
  ({ id: key, key, value, type, ...(enabled === undefined ? {} : { enabled }) }) as NonNullable<
    HttpRequest['body']['formData']
  >[number];

const b64 = (text: string) => Buffer.from(text).toString('base64');

const AUTH: ReadonlyArray<[string, HttpRequest['auth'], Record<string, string>, string?]> = [
  ['bearer', { type: 'bearer', bearer: { token: '{{tok}}' } }, { authorization: 'Bearer T0K' }],
  ['bearer, empty token', { type: 'bearer', bearer: { token: '' } }, {}],
  [
    'basic',
    { type: 'basic', basic: { username: 'u', password: 'p' } },
    { authorization: `Basic ${b64('u:p')}` },
  ],
  [
    'basic, empty password',
    { type: 'basic', basic: { username: 'u', password: '' } },
    { authorization: `Basic ${b64('u:')}` },
  ],
  ['basic, empty username', { type: 'basic', basic: { username: '', password: 'p' } }, {}],
  [
    'api-key in a header',
    { type: 'api-key', apiKey: { key: 'X-Key', value: 'v', in: 'header' } },
    { 'x-key': 'v' },
  ],
  [
    'api-key in the query',
    { type: 'api-key', apiKey: { key: 'k', value: 'v', in: 'query' } },
    {},
    `${URL_BASE}?k=v`,
  ],
  ['api-key, empty value', { type: 'api-key', apiKey: { key: 'k', value: '', in: 'header' } }, {}],
  [
    'oauth2',
    { type: 'oauth2', oauth2: { accessToken: 'at', tokenType: 'MAC' } },
    { authorization: 'MAC at' },
  ],
  [
    'oauth2, empty token type',
    { type: 'oauth2', oauth2: { accessToken: 'at', tokenType: '' } },
    { authorization: 'Bearer at' },
  ],
  ['oauth2, no token', { type: 'oauth2', oauth2: { accessToken: '' } }, {}],
];

const BODIES: ReadonlyArray<[string, HttpRequest['body'], unknown, Record<string, string>?]> = [
  ['none', { type: 'none', raw: 'ignored' }, null],
  ['json', { type: 'json', raw: '{"a":"{{who}}"}' }, '{"a":"ada"}'],
  ['text', { type: 'text', raw: '{{who}}' }, 'ada'],
  [
    'xml',
    { type: 'xml', raw: '<a>{{who}}</a>' },
    '<a>ada</a>',
    { 'content-type': 'application/xml' },
  ],
  ['protobuf', { type: 'protobuf', raw: '{{who}}' }, 'ada'],
  ['protobuf, no raw', { type: 'protobuf' }, null],
  ['multipart-mixed', { type: 'multipart-mixed', raw: '{{who}}' }, 'ada'],
  ['binary', { type: 'binary', raw: b64('bytes') }, { bytes: 'bytes' }],
  [
    'urlencoded rows: only truthy enabled with a key; no file parts',
    {
      type: 'x-www-form-urlencoded',
      formData: [
        row('on', '{{who}}', true),
        row('off', 'x', false),
        row('missing', 'x'),
        row('', 'x', true),
        row('file', 'x', true, 'file'),
      ],
    },
    'on=ada',
  ],
  [
    'urlencoded falls back to raw when no row is sendable',
    { type: 'x-www-form-urlencoded', raw: 'a={{who}}', formData: [row('off', 'x', false)] },
    'a=ada',
  ],
  [
    'multipart rows: only truthy enabled with a key',
    {
      type: 'form-data',
      formData: [
        row('on', '{{who}}', true),
        row('off', 'x', false),
        row('missing', 'x'),
        {
          ...row('up', b64('{{who}}'), true, 'file'),
          fileName: 'a.txt',
          contentType: 'text/plain',
        },
        row('anon', b64('z'), true, 'file'),
      ],
    },
    [
      { name: 'on', value: 'ada' },
      { name: 'up', filename: 'a.txt', type: 'text/plain', text: '{{who}}' },
      { name: 'anon', filename: 'file', type: 'application/octet-stream', text: 'z' },
    ],
  ],
];

describe('Request to proxy spec: both hosts send the same wire request', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ vars: {} });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  });

  describe('auth', () => {
    for (const [name, auth, headers, url] of AUTH) {
      it(name, async () => {
        const req = request({ auth });
        const [renderer, cli] = [await viaRenderer(req), await viaCli(req)];
        expect(renderer).toBeDefined();
        expect(cli).toEqual(renderer);
        for (const [key, value] of Object.entries(headers)) {
          expect(renderer?.headers[key]).toBe(value);
        }
        if (Object.keys(headers).length === 0) {
          expect(renderer?.headers.authorization).toBeUndefined();
        }
        expect(renderer?.url).toBe(url ?? URL_BASE);
      });
    }
  });

  describe('body', () => {
    for (const [name, body, expected, headers] of BODIES) {
      it(name, async () => {
        const req = request({ body });
        const [renderer, cli] = [await viaRenderer(req), await viaCli(req)];
        expect(renderer?.body).toEqual(expected);
        expect(cli).toEqual(renderer);
        for (const [key, value] of Object.entries(headers ?? {})) {
          expect(renderer?.headers[key]).toBe(value);
        }
      });
    }
  });

  it('rows: headers and params use the same enabled-and-keyed rule', async () => {
    const req = request({
      headers: [
        { id: '1', key: 'X-On', value: '{{who}}', enabled: true },
        { id: '2', key: 'X-Off', value: 'x', enabled: false },
        { id: '3', key: '', value: 'x', enabled: true },
      ],
      params: [
        { id: '4', key: 'on', value: '{{who}}', enabled: true },
        { id: '5', key: 'off', value: 'x', enabled: false },
      ],
    });
    const [renderer, cli] = [await viaRenderer(req), await viaCli(req)];
    expect(renderer?.headers['x-on']).toBe('ada');
    expect(renderer?.headers['x-off']).toBeUndefined();
    expect(renderer?.url).toBe(`${URL_BASE}?on=ada`);
    expect(cli).toEqual(renderer);
  });

  it('hands a sign-at-wire descriptor through untouched by the credential step', async () => {
    const req = request({
      auth: { type: 'wsse', wsse: { username: 'u', password: 'p' } },
    });
    const [renderer, cli] = [await viaRenderer(req), await viaCli(req)];
    expect(renderer?.headers['x-wsse']).toMatch(/^UsernameToken /);
    expect(cli?.headers['x-wsse']).toMatch(/^UsernameToken /);
  });
});

describe('deliberate host differences, pinned', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ vars: {} });
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
  });

  it('the CLI resolves a form field name; the app sends it as written', async () => {
    const req = request({
      body: { type: 'x-www-form-urlencoded', formData: [row('{{who}}', 'v', true)] },
    });
    expect((await viaCli(req))?.body).toBe('ada=v');
    expect((await viaRenderer(req))?.body).toBe('%7B%7Bwho%7D%7D=v');
  });

  it('the CLI resolves a {{var}} binary body; the app treats it as bytes', async () => {
    const wire: Wire[] = [];
    await executeHttp(
      {
        relativePath: 'r',
        folderPath: [],
        type: 'http',
        request: request({ body: { type: 'binary', raw: '{{b}}' } }),
      },
      {
        vars: { b: b64('from-var') },
        timeoutMs: 5000,
        allowLocalhost: true,
        fetcher: capturing(wire),
      }
    );
    expect(wire[0]?.body).toEqual({ bytes: 'from-var' });
  });

  it('non-Latin-1 Basic credentials: the CLI encodes UTF-8; the app reports the btoa failure', async () => {
    const auth: HttpRequest['auth'] = {
      type: 'basic',
      basic: { username: '用户', password: 'p' },
    };
    expect((await viaCli(request({ auth })))?.headers.authorization).toBe(`Basic ${b64('用户:p')}`);
    await expect(viaRenderer(request({ auth }))).rejects.toThrow();
  });
});
