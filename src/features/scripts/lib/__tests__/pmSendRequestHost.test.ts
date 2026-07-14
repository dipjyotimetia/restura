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

describe('makeRendererSendRequest — header inheritance', () => {
  it('inherits parent headers as defaults', async () => {
    const send = makeRendererSendRequest({
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
      inheritedHeaders: { Authorization: 'Bearer parent' },
    });
    await send({
      url: 'https://x',
      headers: { Authorization: 'Bearer override' },
    });
    expect(getDispatchedSpec().headers).toEqual({ Authorization: 'Bearer override' });
  });

  it('variables resolve inside both inherited and user headers', async () => {
    const send = makeRendererSendRequest({
      variables: { tok: 'parentTok', usr: 'aliceUsr' },
      inheritedHeaders: { Authorization: 'Bearer {{tok}}' },
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
      /method CONNECT is not allowed/
    );
    expect(executeProxiedRequestMock).not.toHaveBeenCalled();
  });

  it('normalises method casing', async () => {
    const send = makeRendererSendRequest();
    await send({ url: 'https://x', method: 'post' });
    expect(getDispatchedSpec().method).toBe('POST');
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
