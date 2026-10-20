// @vitest-environment node

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockMcpServerHandle, startMockMcpServer } from '../../../e2e/mocks/mcpServer';
import { mcp } from '../mcp';
import { createMcpTerminateHandler } from '../mcp-terminate';

/**
 * `/api/mcp` + `/api/mcp/terminate` against the real SDK-backed mock server
 * used by e2e and echo-local — proves the wire changes (id-less
 * notifications, `MCP-Protocol-Version`, DELETE) are accepted by an
 * SDK-conformant Streamable HTTP server (#862, #865, #888).
 */

const env = { ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' };
const app = new Hono<{ Bindings: typeof env }>();
app.post('/api/mcp', mcp);
app.post('/api/mcp/terminate', createMcpTerminateHandler());

let server: MockMcpServerHandle;

beforeAll(async () => {
  server = await startMockMcpServer();
});

afterAll(async () => {
  await server.close();
});

function post(path: string, body: unknown) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    env
  );
}

describe('MCP lifecycle against the SDK mock server', () => {
  it('initialize → notifications/initialized → tools/list with the negotiated version header', async () => {
    server.reset();
    const base = { url: server.url, transport: 'streamable-http' };
    const init = await post('/api/mcp', {
      ...base,
      jsonRpc: {
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'restura', version: 'test' },
        },
      },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as {
      sessionId?: string;
      jsonRpc: { result: { protocolVersion: string } };
    };
    const protocolVersion = initBody.jsonRpc.result.protocolVersion;
    expect(protocolVersion).toBe('2025-11-25');

    const note = await post('/api/mcp', {
      ...base,
      protocolVersion,
      ...(initBody.sessionId ? { sessionId: initBody.sessionId } : {}),
      jsonRpc: { method: 'notifications/initialized' },
    });
    expect(note.status).toBe(200);
    expect(await note.json()).toMatchObject({ ok: true, accepted: true });

    const list = await post('/api/mcp', {
      ...base,
      protocolVersion,
      jsonRpc: { method: 'tools/list', id: 2 },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { jsonRpc: { result: { tools: unknown[] } } };
    expect(listBody.jsonRpc.result.tools.length).toBeGreaterThan(0);

    expect(server.methodsReceived()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);
  });

  it('a version the server does not support is rejected (header is really sent)', async () => {
    const res = await post('/api/mcp', {
      url: server.url,
      transport: 'streamable-http',
      protocolVersion: '1999-01-01',
      jsonRpc: { method: 'tools/list', id: 3 },
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { upstreamStatus?: number }).upstreamStatus).toBe(400);
  });

  it('terminate issues DELETE and reports a stateless server as best-effort ok', async () => {
    const res = await post('/api/mcp/terminate', {
      url: server.url,
      transport: 'streamable-http',
      sessionId: 'any',
      protocolVersion: '2025-11-25',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
