import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase C follow-up — `makeRendererSendRequest` host bridge.
 *
 * Two behaviours that distinguish it from a naive passthrough:
 *  1. Variable substitution: `{{var}}` in URL / headers / string body
 *     is resolved against the variable map captured at construction.
 *  2. Header inheritance: parent-request headers (auth + content-type)
 *     are merged in as defaults; user-supplied headers in the
 *     sendRequest input win on collision.
 */

const executeProxiedRequestMock = vi.fn();
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => executeProxiedRequestMock(...args),
}));

import { makeRendererSendRequest } from '../pmSendRequestHost';

beforeEach(() => {
  executeProxiedRequestMock.mockReset();
  executeProxiedRequestMock.mockResolvedValue({
    status: 200,
    statusText: 'OK',
    headers: {},
    data: '{}',
    size: 2,
  });
});

function getDispatchedSpec(): ProxyRequestBody {
  return executeProxiedRequestMock.mock.calls[0]?.[0] as ProxyRequestBody;
}

describe('makeRendererSendRequest — variable substitution', () => {
  it('resolves {{var}} in the URL', async () => {
    const send = makeRendererSendRequest({
      variables: { base_url: 'https://api.example.com', user_id: '42' },
    });
    await send({ url: '{{base_url}}/users/{{user_id}}' });
    expect(getDispatchedSpec().url).toBe('https://api.example.com/users/42');
  });

  it('resolves {{var}} in header values', async () => {
    const send = makeRendererSendRequest({
      variables: { token: 'abc123' },
    });
    await send({
      url: 'https://x',
      headers: { Authorization: 'Bearer {{token}}' },
    });
    expect(getDispatchedSpec().headers).toMatchObject({ Authorization: 'Bearer abc123' });
  });

  it('resolves {{var}} in a string body', async () => {
    const send = makeRendererSendRequest({
      variables: { name: 'alice' },
    });
    await send({
      url: 'https://x',
      method: 'POST',
      body: '{"name":"{{name}}"}',
    });
    expect(getDispatchedSpec().data).toBe('{"name":"alice"}');
    expect(getDispatchedSpec().bodyType).toBe('json');
  });

  it('leaves {{var}} literal when the variable is undefined', async () => {
    const send = makeRendererSendRequest({ variables: {} });
    await send({ url: 'https://x/{{missing}}' });
    expect(getDispatchedSpec().url).toBe('https://x/{{missing}}');
  });
});

describe('makeRendererSendRequest — inheritance by origin', () => {
  const PARENT = 'https://api.example.com/parent';
  const INHERITED = {
    Authorization: 'Bearer parent',
    'Proxy-Authorization': 'Basic parent',
    Cookie: 'session=parent',
    'X-Api-Key': 'parent-key',
    'X-Custom-Name': 'parent-custom',
    'X-Trace': 'abc',
  };
  const inherit = (url: string, parentUrl: string | undefined = PARENT) =>
    makeRendererSendRequest({
      ...(parentUrl !== undefined ? { parentUrl } : {}),
      inheritedHeaders: INHERITED,
    })({ url });

  it.each([
    ['same origin, other path', 'https://api.example.com/other?q=1'],
    ['same origin, explicit default port', 'https://api.example.com:443/other'],
    ['same origin, other case', 'https://API.example.com/other'],
  ])('keeps every inherited header: %s', async (_name, url) => {
    await inherit(url);
    expect(getDispatchedSpec().headers).toEqual(INHERITED);
  });

  it.each([
    ['different host', 'https://other.example.com/'],
    ['subdomain', 'https://sub.api.example.com/'],
    ['different port', 'https://api.example.com:8443/'],
    ['different scheme', 'http://api.example.com/'],
    ['relative URL', '/other'],
    ['unparseable URL', 'not a url'],
    ['token in the host', 'https://{{unknown}}/'],
  ])('inherits nothing: %s', async (_name, url) => {
    await inherit(url);
    expect(getDispatchedSpec().headers).toEqual({});
  });

  it.each([
    ['no parent URL', undefined],
    ['unparseable parent URL', 'not a url'],
    ['opaque parent origin', 'data:text/plain,x'],
  ])('fails closed: %s', async (_name, parentUrl) => {
    await makeRendererSendRequest({
      ...(parentUrl !== undefined ? { parentUrl } : {}),
      inheritedHeaders: INHERITED,
    })({ url: 'https://api.example.com/' });
    expect(getDispatchedSpec().headers).toEqual({});
  });

  it('marks inherited headers to drop on a redirect, not script-set ones', async () => {
    await makeRendererSendRequest({ parentUrl: PARENT, inheritedHeaders: INHERITED })({
      url: 'https://api.example.com/other',
      headers: { 'x-trace': 'script', 'X-Script': 's' },
    });
    expect(getDispatchedSpec().redirectPolicy?.stripOnOriginChange).toEqual([
      'Authorization',
      'Proxy-Authorization',
      'Cookie',
      'X-Api-Key',
      'X-Custom-Name',
    ]);
  });

  it('marks nothing when nothing is inherited', async () => {
    await makeRendererSendRequest({ parentUrl: PARENT, inheritedHeaders: INHERITED })({
      url: 'https://other.example.com/',
    });
    expect(getDispatchedSpec().redirectPolicy).toBeUndefined();
  });

  it('keeps headers the script sets, cross-origin', async () => {
    await makeRendererSendRequest({ parentUrl: PARENT, inheritedHeaders: INHERITED })({
      url: 'https://other.example.com/',
      headers: { Authorization: 'Bearer script', 'X-Api-Key': 'script-key' },
    });
    expect(getDispatchedSpec().headers).toEqual({
      Authorization: 'Bearer script',
      'X-Api-Key': 'script-key',
    });
  });

  it('applies the rule to templates against the resolved parent URL', async () => {
    const send = makeRendererSendRequest({
      variables: { host: 'api.example.com', tok: 't' },
      parentUrlTemplate: 'https://{{host}}/parent',
      inheritedHeaderTemplates: { Authorization: 'Bearer {{tok}}', 'X-Trace': '{{tok}}' },
    });
    await send({ url: 'https://api.example.com/x' });
    expect(getDispatchedSpec().headers).toEqual({ Authorization: 'Bearer t', 'X-Trace': 't' });
    executeProxiedRequestMock.mockClear();
    await send({ url: 'https://other.example.com/' });
    expect(getDispatchedSpec().headers).toEqual({});
  });
});

describe('makeRendererSendRequest — header inheritance', () => {
  it('inherits parent headers as defaults', async () => {
    const send = makeRendererSendRequest({
      parentUrl: 'https://x/parent',
      inheritedHeaders: { Authorization: 'Bearer parent-token', 'X-Trace': 'abc' },
    });
    await send({ url: 'https://x' });
    expect(getDispatchedSpec().headers).toEqual({
      Authorization: 'Bearer parent-token',
      'X-Trace': 'abc',
    });
  });

  it('user-supplied headers override inherited on collision', async () => {
    const send = makeRendererSendRequest({
      parentUrl: 'https://x/parent',
      inheritedHeaders: { Authorization: 'Bearer parent' },
    });
    await send({
      url: 'https://x',
      headers: { Authorization: 'Bearer override' },
    });
    expect(getDispatchedSpec().headers).toEqual({ Authorization: 'Bearer override' });
  });

  it('sends inherited headers as they are', async () => {
    const send = makeRendererSendRequest({
      variables: { tok: 'abc' },
      parentUrl: 'https://x.test/parent',
      inheritedHeaders: { Authorization: 'Bearer {{tok}}' },
    });
    await send({ url: 'https://x.test', method: 'GET' });
    expect(getDispatchedSpec().headers).toEqual({ Authorization: 'Bearer {{tok}}' });
  });

  it.each([
    ['URL', { url: 'https://x.test/{{sec}}', method: 'GET' }],
    ['padded URL', { url: 'https://x.test/{{ sec }}', method: 'GET' }],
    ['header', { url: 'https://x.test', method: 'GET', headers: { X: '{{sec}}' } }],
    ['body', { url: 'https://x.test', method: 'POST', body: '{{sec}}' }],
    ['value', { url: '{{next}}', method: 'GET' }],
  ])('refuses a secret variable in a %s and sends nothing', async (_name, input) => {
    const send = makeRendererSendRequest({
      variables: { sec: 'P', next: '{{sec}}', plain: 'v' },
      secretNames: ['sec'],
    });
    await expect(send(input)).rejects.toThrow(/secret variable "sec"/);
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('keeps resolving non-secret variables beside a secret name', async () => {
    const send = makeRendererSendRequest({
      variables: { sec: 'P', plain: 'v' },
      secretNames: ['sec'],
    });
    await send({ url: 'https://x.test/{{plain}}', method: 'GET' });
    expect(getDispatchedSpec().url).toBe('https://x.test/v');
  });

  it('variables resolve inside both inherited templates and user headers', async () => {
    const send = makeRendererSendRequest({
      variables: { tok: 'parentTok', usr: 'aliceUsr' },
      parentUrlTemplate: 'https://x/parent',
      inheritedHeaderTemplates: { Authorization: 'Bearer {{tok}}' },
    });
    await send({
      url: 'https://x',
      headers: { 'X-User': '{{usr}}' },
    });
    expect(getDispatchedSpec().headers).toEqual({
      Authorization: 'Bearer parentTok',
      'X-User': 'aliceUsr',
    });
  });
});

describe('makeRendererSendRequest — method allowlist', () => {
  it('rejects an unsupported method', async () => {
    const send = makeRendererSendRequest();
    await expect(send({ url: 'https://x', method: 'CONNECT' })).rejects.toThrow(
      /Method CONNECT is not allowed/
    );
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('normalises method casing', async () => {
    const send = makeRendererSendRequest();
    await send({ url: 'https://x', method: 'post' });
    expect(getDispatchedSpec().method).toBe('POST');
  });

  it('passes an extension method (PROPFIND) through verbatim', async () => {
    const send = makeRendererSendRequest();
    await send({ url: 'https://x', method: 'PROPFIND' });
    expect(getDispatchedSpec().method).toBe('PROPFIND');
  });

  it('surfaces the policy reason for a non-token method', async () => {
    const send = makeRendererSendRequest();
    await expect(send({ url: 'https://x', method: 'BAD METHOD' })).rejects.toThrow(
      'pm.sendRequest: Method "BAD METHOD" is not a valid HTTP method token'
    );
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('rejects TRACE in any casing', async () => {
    const send = makeRendererSendRequest();
    await expect(send({ url: 'https://x', method: 'trace' })).rejects.toThrow(/not allowed/);
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });
});

describe('makeRendererSendRequest — abort propagation', () => {
  it('forwards the parent abort signal', async () => {
    const ctrl = new AbortController();
    const send = makeRendererSendRequest({ signal: ctrl.signal });
    await send({ url: 'https://x' });
    const opts = executeProxiedRequestMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
    expect(opts?.signal).toBe(ctrl.signal);
  });
});

describe('makeRendererSendRequest — Set-Cookie (#855)', () => {
  it('returns every Set-Cookie field alongside the flat headers', async () => {
    const cookies = ['a=1; Path=/', 'b=2'];
    executeProxiedRequestMock.mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      headers: { 'set-cookie': 'b=2' },
      setCookies: cookies,
      data: '',
      size: 0,
    });
    const res = await makeRendererSendRequest({})({ url: 'https://x' });
    expect(res.setCookies).toEqual(cookies);
  });

  it('omits setCookies when the response has none', async () => {
    const res = await makeRendererSendRequest({})({ url: 'https://x' });
    expect(res).not.toHaveProperty('setCookies');
  });
});
