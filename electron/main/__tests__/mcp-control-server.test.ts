/**
 * The loopback control listener, driven by the real MCP SDK client over
 * streamable HTTP — the same path Claude Code / Codex take with an HTTP
 * config, and the path the stdio shim relays through.
 */
import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ControlToolResult } from '@shared/mcp-server/control-bridge';
import { CONTROL_TOOLS } from '@shared/mcp-server/control-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ControlHttpServerHandle,
  type ControlToolCall,
  clientFromMeta,
  startControlHttpServer,
} from '../handlers/mcp-control-server';

const TOKEN = 'a'.repeat(43);
const handles: ControlHttpServerHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
  await Promise.allSettled(handles.splice(0).map((h) => h.close()));
});

async function start(
  dispatch: (call: ControlToolCall) => Promise<ControlToolResult>,
  extra: { rateLimit?: number; preferredPort?: number; token?: string } = {}
) {
  const handle = await startControlHttpServer({
    identity: { name: 'restura', version: '9.9.9' },
    getToken: () => extra.token ?? TOKEN,
    dispatch,
    ...(extra.rateLimit !== undefined ? { rateLimit: extra.rateLimit } : {}),
    ...(extra.preferredPort !== undefined ? { preferredPort: extra.preferredPort } : {}),
  });
  handles.push(handle);
  return handle;
}

async function connect(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'vitest-agent', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Raw request with full control over Host / Origin (fetch forbids setting Host). */
function rawPost(
  port: number,
  headers: Record<string, string>,
  pathname = '/mcp'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}

describe('control server over streamable HTTP', () => {
  it('lists the full catalogue with titles and honest annotations, bound to loopback', async () => {
    const handle = await start(async () => ({ ok: true, data: null }));
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/mcp`);
    const client = await connect(handle.url);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(CONTROL_TOOLS.map((t) => t.name).sort());
    const send = tools.find((t) => t.name === 'send_request');
    expect(send?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
    const del = tools.find((t) => t.name === 'delete_collection');
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toMatch(/describe_access/);
  });

  it('forwards a validated call to the dispatcher with the client label and returns its data', async () => {
    const dispatch = vi.fn(async (_call: ControlToolCall) => ({
      ok: true as const,
      data: { collections: [{ id: 'c1', name: 'Orders' }] },
    }));
    const handle = await start(dispatch);
    const client = await connect(handle.url, { 'x-restura-mcp-client': 'claude-code/2 (stdio)' });

    const result = await client.callTool({ name: 'list_collections', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      collections: [{ id: 'c1', name: 'Orders' }],
    });
    expect(dispatch).toHaveBeenCalledOnce();
    const call = dispatch.mock.calls[0]![0];
    expect(call.tool).toBe('list_collections');
    expect(call.client).toEqual({ name: 'claude-code/2 (stdio)' });
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a refused call to an MCP tool error', async () => {
    const handle = await start(async () => ({
      ok: false,
      error: 'This collection is hidden from MCP agents.',
    }));
    const client = await connect(handle.url);
    const result = await client.callTool({ name: 'get_request', arguments: { requestId: 'r1' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toMatch(/hidden/);
  });

  it('rejects schema-invalid arguments before they reach the renderer', async () => {
    const dispatch = vi.fn(async () => ({ ok: true as const, data: null }));
    const handle = await start(dispatch);
    const client = await connect(handle.url);
    const result = await client
      .callTool({
        name: 'create_request',
        arguments: {
          collectionId: 'c1',
          request: {
            type: 'http',
            name: 'x',
            url: 'https://a',
            auth: { type: 'bearer', token: 'sk-live' },
          },
        },
      })
      .catch((err: Error) => ({ isError: true, content: [{ text: err.message }] }));
    expect(result.isError).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('deep-redacts secret-named fields in results as a last line of defence', async () => {
    const handle = await start(async () => ({
      ok: true,
      data: { auth: { type: 'basic', basic: { username: 'u', password: 'hunter2' } } },
    }));
    const client = await connect(handle.url);
    const result = await client.callTool({ name: 'get_request', arguments: { requestId: 'r1' } });
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain('hunter2');
  });
});

describe('control server transport security', () => {
  it('401s without or with a wrong bearer token', async () => {
    const handle = await start(async () => ({ ok: true, data: null }));
    const none = await rawPost(handle.port, { host: `127.0.0.1:${handle.port}` });
    expect(none.status).toBe(401);
    const wrong = await rawPost(handle.port, {
      host: `127.0.0.1:${handle.port}`,
      authorization: `Bearer ${'b'.repeat(43)}`,
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses everything while the token is unset', async () => {
    const handle = await start(async () => ({ ok: true, data: null }), { token: '' });
    const res = await rawPost(handle.port, {
      host: `127.0.0.1:${handle.port}`,
      authorization: 'Bearer ',
    });
    expect(res.status).toBe(401);
  });

  it('403s a browser request (Origin present) even with the right token — CSRF', async () => {
    const handle = await start(async () => ({ ok: true, data: null }));
    const res = await rawPost(handle.port, {
      host: `127.0.0.1:${handle.port}`,
      origin: 'https://evil.example',
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(403);
  });

  it('403s a DNS-rebound Host even with the right token', async () => {
    const handle = await start(async () => ({ ok: true, data: null }));
    const res = await rawPost(handle.port, {
      host: `rebind.evil.example:${handle.port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(res.status).toBe(403);
  });

  it('404s any path other than /mcp', async () => {
    const handle = await start(async () => ({ ok: true, data: null }));
    const res = await rawPost(
      handle.port,
      { host: `127.0.0.1:${handle.port}`, authorization: `Bearer ${TOKEN}` },
      '/admin'
    );
    expect(res.status).toBe(404);
  });

  it('429s past the rate limit', async () => {
    const handle = await start(async () => ({ ok: true, data: null }), { rateLimit: 2 });
    const headers = { host: `127.0.0.1:${handle.port}`, authorization: `Bearer ${TOKEN}` };
    await rawPost(handle.port, headers);
    await rawPost(handle.port, headers);
    expect((await rawPost(handle.port, headers)).status).toBe(429);
  });

  it('falls back to an ephemeral port when the preferred one is taken', async () => {
    const first = await start(async () => ({ ok: true, data: null }));
    const second = await start(async () => ({ ok: true, data: null }), {
      preferredPort: first.port,
    });
    expect(second.port).not.toBe(first.port);
    // And reuses the preferred port when it is free.
    const port = second.port;
    await second.close();
    handles.splice(handles.indexOf(second), 1);
    const third = await start(async () => ({ ok: true, data: null }), { preferredPort: port });
    expect(third.port).toBe(port);
  });
});

describe('clientFromMeta', () => {
  it('reads the 2026-07-28 clientInfo request meta and cleans it', () => {
    expect(
      clientFromMeta({
        'io.modelcontextprotocol/clientInfo': { name: 'codex\u0007', version: '0.9' },
      })
    ).toEqual({ name: 'codex', version: '0.9' });
    expect(clientFromMeta({ 'io.modelcontextprotocol/clientInfo': { name: '' } })).toBeUndefined();
    expect(clientFromMeta(undefined)).toBeUndefined();
  });
});
