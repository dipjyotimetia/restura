// @vitest-environment node
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Fetcher } from '@shared/protocol/types';
import { describe, expect, it, vi } from 'vitest';

/**
 * A pre-request script that edits `rs.request.headers` must produce the same
 * wire headers on the app and in the CLI: both hand the script the saved
 * header templates (not resolved values) and fold the edits back against them.
 */
const proxied = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/transport', () => ({
  executeProxiedRequest: (...args: unknown[]) => proxied(...args),
  executeProxiedStreamingRequest: vi.fn(),
  ProxyTransportError: class ProxyTransportError extends Error {},
}));

import { executeHttp } from '../../cli/src/runner/executors/http';
import { applyPreRequestMetadata, runPreRequestScript } from '../../cli/src/runner/scriptRunner';
import { executeRequest } from '../../src/features/http/lib/requestExecutor';
import { useEnvironmentStore } from '../../src/store/useEnvironmentStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import type { HttpRequest } from '../../src/types';

const VARS = { tenant: 'acme' };

function capturing(sink: Array<Record<string, string>>): Fetcher {
  return async (req) => {
    sink.push(
      Object.fromEntries(
        Object.entries(req.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
      )
    );
    return {
      status: 200,
      statusText: 'OK',
      headers: {},
      text: async () => '',
      contentLengthHeader: '0',
    };
  };
}

async function viaRenderer(request: HttpRequest): Promise<Record<string, string> | undefined> {
  const wire: Array<Record<string, string>> = [];
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

async function viaCli(request: HttpRequest): Promise<Record<string, string> | undefined> {
  const wire: Array<Record<string, string>> = [];
  const item = { relativePath: 'r', folderPath: [], type: 'http' as const, request };
  const runCtx = { collectionVars: {}, iterationData: {}, iteration: 0, iterationCount: 1 };
  const pre = await runPreRequestScript(request.preRequestScript ?? '', item, VARS, runCtx);
  const sent = applyPreRequestMetadata(item, pre, VARS);
  const outcome = await executeHttp(sent, {
    vars: pre.variables,
    timeoutMs: 5000,
    allowLocalhost: true,
    fetcher: capturing(wire),
  });
  if (outcome.errorMessage) throw new Error(outcome.errorMessage);
  return wire[0];
}

function request(preRequestScript: string): HttpRequest {
  return {
    id: 'r',
    name: 'r',
    type: 'http',
    method: 'GET',
    url: 'https://api.example.com/x',
    headers: [{ id: 't', key: 'X-Tenant', value: '{{tenant}}', enabled: true }],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
    preRequestScript,
  };
}

describe('pre-request header edits: app and CLI send the same headers', () => {
  it.each([
    [
      'script reads a header template',
      `rs.request.headers['X-View'] = rs.request.headers['X-Tenant'].includes('{{') ? 'template' : 'resolved';`,
      { 'x-tenant': 'acme', 'x-view': 'template' },
    ],
    [
      'script extends a templated header',
      `rs.request.headers['X-Tenant'] = rs.request.headers['X-Tenant'] + '-eu';`,
      { 'x-tenant': 'acme-eu' },
    ],
    ['script removes a header', `delete rs.request.headers['X-Tenant'];`, {}],
  ])('%s', async (_name, script, expected) => {
    const app = await viaRenderer(request(script));
    const cli = await viaCli(request(script));
    expect(app).toMatchObject(expected);
    expect(cli).toMatchObject(expected);
    expect(cli?.['x-tenant']).toBe(app?.['x-tenant']);
    expect(cli?.['x-view']).toBe(app?.['x-view']);
  });
});
