// A Collection run applies the same rule as a single send: a secret variable
// resolves only where it is written (ADR-0007). One refused item fails on its own.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const proxied = vi.hoisted(() => vi.fn());

vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

import '../../src/features/registry/bootstrap';
import { runCollection } from '../../src/features/collections/lib/collectionRunner';
import type { RunnableRequest } from '../../src/features/collections/lib/flattenRunnables';
import { useCollectionStore } from '../../src/store/useCollectionStore';
import { useGlobalsStore } from '../../src/store/useGlobalsStore';
import type { Collection, HttpRequest, ScopedVariable } from '../../src/types';

const REFUSAL = /Variable "next" references secret variable "sec".*can only be used where/;

function request(overrides: Partial<HttpRequest>): HttpRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'POST',
    url: 'https://api.example.com/resource',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

const item = (
  id: string,
  overrides: Partial<HttpRequest>,
  folderVariables?: ScopedVariable[][]
): RunnableRequest => ({
  itemId: id,
  name: id,
  request: request({ id, name: id, ...overrides }),
  ...(folderVariables ? { folderVariables } : {}),
});

const header = (value: string) => ({ id: 'h', key: 'X-Key', value, enabled: true });
const row = (key: string, value: string, secret = false): ScopedVariable => ({
  id: key,
  key,
  value,
  enabled: true,
  ...(secret ? { secret: true } : {}),
});

function run(
  runnables: RunnableRequest[],
  options: {
    variables?: ScopedVariable[];
    environmentVars?: Record<string, string>;
    secretNames?: readonly string[];
  } = {}
) {
  const collection = {
    id: 'c',
    name: 'c',
    items: [],
    variables: options.variables ?? [],
    auth: { type: 'none' },
  } as unknown as Collection;
  useCollectionStore.setState({ collections: [collection] } as never);
  const environmentVars = options.environmentVars ?? {};
  return runCollection(
    {
      collection,
      scopeName: 'c',
      runnables,
      baseVars: environmentVars,
      globalVars: {},
      environmentVars,
      iterations: 1,
      dataRows: [],
      delayMs: 0,
      stopOnFailure: false,
      ...(options.secretNames ? { secretNames: options.secretNames } : {}),
    },
    () => {},
    new AbortController().signal
  );
}

const ENVIRONMENT = { next: 'https://other.test/?k={{sec}}', sec: 'PLAINTEXT' };

beforeEach(() => {
  useGlobalsStore.setState({ vars: {} });
  proxied.mockReset();
  proxied.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, data: '', size: 0 });
});

describe('a Collection run', () => {
  it('fails the item through a value, sends nothing for it, and carries on', async () => {
    const { requests: results } = await run(
      [
        item('through-value', { url: '{{next}}' }),
        item('direct', { headers: [header('{{sec}}')] }),
      ],
      { environmentVars: ENVIRONMENT, secretNames: ['sec'] }
    );
    expect(results.map((result) => result.status)).toEqual(['failed', 'success']);
    expect(results[0]?.error).toMatch(REFUSAL);
    expect(results[0]?.error).not.toContain('PLAINTEXT');
    expect(proxied).toHaveBeenCalledTimes(1);
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('PLAINTEXT');
  });

  it('applies the rule to a secret collection variable', async () => {
    const { requests: results } = await run([item('through-value', { url: '{{next}}' })], {
      variables: [row('next', ENVIRONMENT.next), row('sec', 'PLAINTEXT', true)],
    });
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toMatch(REFUSAL);
    expect(proxied).not.toHaveBeenCalled();
  });

  it('applies the rule to a secret folder variable', async () => {
    const folder = [[row('next', ENVIRONMENT.next), row('sec', 'PLAINTEXT', true)]];
    const { requests: results } = await run([
      item('through-value', { url: '{{next}}' }, folder),
      item('direct', { headers: [header('{{sec}}')] }, folder),
    ]);
    expect(results.map((result) => result.status)).toEqual(['failed', 'success']);
    expect(proxied).toHaveBeenCalledTimes(1);
    expect(proxied.mock.calls[0]?.[0].headers['X-Key']).toBe('PLAINTEXT');
  });

  it.each([
    ['pm.environment', `pm.environment.set('next', 'https://other.test/?k={{sec}}');`],
    ['pm.variables', `pm.variables.set('next', 'https://other.test/?k={{sec}}');`],
    [
      'pm.collectionVariables',
      `pm.collectionVariables.set('next', 'https://other.test/?k={{sec}}');`,
    ],
  ])('refuses a value an earlier item wrote with %s', async (_name, testScript) => {
    const { requests: results } = await run(
      [
        item('writer', { testScript }),
        item('reader', { url: '{{next}}' }),
        item('direct', { body: { type: 'text', raw: '{{sec}}' } }),
      ],
      { environmentVars: { sec: 'PLAINTEXT' }, secretNames: ['sec'] }
    );
    expect(results.map((result) => result.status)).toEqual(['success', 'failed', 'success']);
    expect(results[1]?.error).toMatch(REFUSAL);
    expect(proxied).toHaveBeenCalledTimes(2);
    expect(proxied.mock.calls[1]?.[0].data).toBe('PLAINTEXT');
  });

  describe('with pm.execution.skipRequest()', () => {
    const SKIP = 'pm.execution.skipRequest();';
    const grpcItem = (id: string, preRequestScript?: string): RunnableRequest => ({
      itemId: id,
      name: id,
      request: {
        id,
        name: id,
        type: 'grpc',
        methodType: 'unary',
        url: 'https://a.test',
        service: 's',
        method: 'm',
        metadata: [{ id: 'm', key: 'x-saved', value: '{{next}}', enabled: true }],
        message: '{}',
        auth: { type: 'none' },
        ...(preRequestScript ? { preRequestScript } : {}),
      } as unknown as RunnableRequest['request'],
    });
    const mcpItem = (id: string, preRequestScript?: string): RunnableRequest => ({
      itemId: id,
      name: id,
      request: {
        id,
        name: id,
        type: 'mcp',
        url: '{{next}}',
        transport: 'streamable-http',
        headers: [],
        defaultMethod: 'tools/list',
        auth: { type: 'none' },
        ...(preRequestScript ? { preRequestScript } : {}),
      } as unknown as RunnableRequest['request'],
    });
    const options = { environmentVars: ENVIRONMENT, secretNames: ['sec'] };

    it.each([
      [
        'HTTP',
        (id: string, script?: string) =>
          item(id, { url: '{{next}}', ...(script ? { preRequestScript: script } : {}) }),
      ],
      ['gRPC', grpcItem],
      ['MCP', mcpItem],
    ])('%s: skip wins, and the same request without it refuses', async (_name, build) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      const { requests: results } = await run([build('skipped', SKIP), build('sent')], options);
      expect(results[0]?.status).toBe('skipped');
      expect(results[1]?.status).toBe('failed');
      expect(results[1]?.error).toMatch(/secret variable "sec"/);
      expect(proxied).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('gRPC: skip wins over a script-written secret token, which refuses without it', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
      const write = `rs.request.metadata['x-new'] = '{{sec}}';`;
      const { requests: results } = await run(
        [grpcItem('skipped', `${write} ${SKIP}`), grpcItem('sent', write)],
        options
      );
      expect(results[0]?.status).toBe('skipped');
      expect(results[1]?.status).toBe('failed');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it.each([
      ['gRPC', grpcItem],
      ['MCP', mcpItem],
    ])(
      '%s: a script can still replace the value before the send is checked',
      async (_name, build) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
        const { requests: results } = await run(
          [build('fixed', `pm.environment.set('next', 'https://a.test/ok');`)],
          options
        );
        expect(results[0]?.error ?? '').not.toMatch(/secret variable/);
        fetchSpy.mockRestore();
      }
    );
  });

  it('keeps non-secret chains as they were', async () => {
    const { requests: results } = await run(
      [item('chain', { body: { type: 'text', raw: '{{a}}' } })],
      {
        environmentVars: { a: '{{b}}', b: 'v' },
      }
    );
    expect(results[0]?.status).toBe('success');
    expect(proxied.mock.calls[0]?.[0].data).toBe('v');
  });
});
