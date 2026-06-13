// @vitest-environment node
// Proves GraphQL introspection round-trips through the REAL Electron undici
// fetcher: a POST of the official introspection query to the mock /graphql
// endpoint comes back with a populated __schema. This is the desktop path that
// introspectSchema() drives via executeProxiedRequest → IPC → executeHttpProxy.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getIntrospectionQuery, buildClientSchema, type IntrospectionQuery } from 'graphql';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  session: { defaultSession: { resolveProxy: vi.fn() } },
}));

import { buildElectronFetcher, type HttpRequestConfig } from '../http-handler';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { startMockHttpServer, type MockHttpServerHandle } from '../../../e2e/mocks/httpServer';

let server: MockHttpServerHandle;
beforeAll(async () => {
  server = await startMockHttpServer({ port: 0 });
});
afterAll(async () => {
  await server.close();
});

describe('GraphQL introspection over the Electron fetcher', () => {
  it('POSTs the introspection query and gets a usable __schema back', async () => {
    const url = `${server.url}/graphql`;
    const fetcher = buildElectronFetcher(
      { method: 'POST', url, verifySsl: true } as HttpRequestConfig,
      null
    );
    const result = await executeHttpProxy(
      {
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        bodyType: 'json',
        data: JSON.stringify({ query: getIntrospectionQuery() }),
      },
      fetcher,
      { allowLocalhost: true }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.response.status).toBe(200);
    const body = JSON.parse(result.response.body) as { data: IntrospectionQuery };
    expect(body.data.__schema).toBeDefined();
    // buildClientSchema only succeeds on a complete introspection result.
    const schema = buildClientSchema(body.data);
    expect(schema.getQueryType()?.getFields()['hello']).toBeDefined();
  });
});
