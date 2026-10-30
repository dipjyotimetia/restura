// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  startGraphqlSseServer,
  startLegacyGraphqlWsServer,
} from '../../e2e/mocks/graphqlSubscriptionServers';
import { startMockOAuthServer } from '../../e2e/mocks/mcpOAuthServer';
import { startMockMcpServer } from '../../e2e/mocks/mcpServer';
import { buildManifest } from '../../echo-local/manifest';
import { IN_PROCESS_SERVICES, PORTS, TLS_SERVICES } from '../../echo-local/ports';

// echo-local must be able to serve every upstream the mocks can — otherwise a
// desktop tester hits a protocol the automated suites cover but the local
// stack can't: MCP OAuth (#856), the v2 MCP era (#858/#872), and the two
// non-default GraphQL subscription protocols (#889).

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((c) => c()));
});

describe('echo-local service registry', () => {
  it('registers the MCP v2, MCP OAuth and GraphQL subscription services on stable ports', () => {
    for (const id of ['mcpV2', 'mcpOAuth', 'graphqlSse', 'graphqlWsLegacy'] as const) {
      expect(IN_PROCESS_SERVICES, id).toContain(id);
      expect(TLS_SERVICES.has(id), id).toBe(false);
    }
    expect(PORTS.mcpV2).toBe(8088);
    expect(PORTS.mcpOAuthAs).toBe(8089);
    expect(PORTS.mcpOAuthResource).toBe(8093);
    expect(PORTS.graphqlSse).toBe(8091);
    expect(PORTS.graphqlWsLegacy).toBe(8092);
  });

  it('never assigns one port to two services', () => {
    const values = Object.values(PORTS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('lists every service and the verifying auth routes in the manifest', () => {
    const m = buildManifest({ host: 'localhost' });
    expect(m.endpoints.mcpV2).toContain('http://localhost:8088/mcp');
    expect(m.endpoints.mcpOAuth).toContain('http://localhost:8093/mcp');
    expect(m.endpoints['mcpOAuth.authorizationServer']).toContain('http://localhost:8089');
    expect(m.endpoints.graphqlSse).toContain('http://localhost:8091/graphql/stream');
    expect(m.endpoints.graphqlWsLegacy).toContain('ws://localhost:8092/graphql');
    expect(m.endpoints.mqttWs).toContain('ws://localhost:8083/mqtt');
    expect(m.endpoints.mqttWss).toContain('wss://localhost:8084/mqtt');
    // OAuth1 IS verified server-side — the manifest must not claim otherwise.
    expect(m.endpoints['auth.oauth1Protected']).toContain('/oauth1/protected');
    const lossy = m.manual.lossyAuth as { oauth1: string };
    expect(lossy.oauth1).toContain('/oauth1/protected');
    expect(lossy.oauth1).not.toMatch(/no server endpoint verifies/);
  });
});

describe('fixed-port factories the launcher relies on', () => {
  it('OAuth authorization server honours `port` and serves RFC 8414 metadata', async () => {
    const as = await startMockOAuthServer({ port: 0 });
    closers.push(as.close);
    const res = await fetch(`${as.url}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { issuer: string; registration_endpoint: string };
    expect(meta.issuer).toBe(as.url);
    expect(meta.registration_endpoint).toBe(`${as.url}/register`);
  });

  it('OAuth-protected MCP resource challenges with resource_metadata pointing at the AS', async () => {
    const as = await startMockOAuthServer({ port: 0 });
    closers.push(as.close);
    const mcp = await startMockMcpServer({
      port: 0,
      oauth: {
        isAuthorized: (authorization) => {
          const m = /^Bearer\s+(.+)$/.exec(authorization);
          return m !== null && as.isValidAccessToken(m[1]!);
        },
        authorizationServers: [as.url],
      },
    });
    closers.push(mcp.close);
    const challenge = await fetch(mcp.url, { method: 'POST' });
    expect(challenge.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      challenge.headers.get('www-authenticate') ?? ''
    )?.[1];
    expect(metadataUrl).toBeTruthy();
    const doc = (await (await fetch(metadataUrl!)).json()) as { authorization_servers: string[] };
    expect(doc.authorization_servers).toEqual([as.url]);
  });

  it('OAuth-protected MCP resource identifies itself by the host the client dialled', async () => {
    // echo-local advertises `localhost` while the listener binds 127.0.0.1; the
    // SDK's auth flow rejects a PRM `resource` whose origin differs from the
    // server URL, so both the challenge URL and the document must follow Host.
    const as = await startMockOAuthServer({ port: 0 });
    closers.push(as.close);
    const mcp = await startMockMcpServer({
      port: 0,
      oauth: { isAuthorized: () => false, authorizationServers: [as.url] },
    });
    closers.push(mcp.close);
    const viaLocalhost = `http://localhost:${mcp.port}/mcp`;
    const challenge = await fetch(viaLocalhost, { method: 'POST' });
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      challenge.headers.get('www-authenticate') ?? ''
    )?.[1];
    expect(metadataUrl).toBe(
      `http://localhost:${mcp.port}/.well-known/oauth-protected-resource/mcp`
    );
    const doc = (await (await fetch(metadataUrl!)).json()) as { resource: string };
    expect(doc.resource).toBe(viaLocalhost);
  });

  it('graphql-sse server rejects invalid JSON with 400 and keeps serving', async () => {
    const sse = await startGraphqlSseServer({ port: 0 });
    closers.push(sse.close);
    const bad = await fetch(sse.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
    const good = await fetch(sse.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'subscription { tick(count: 1) { n } }' }),
    });
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('event: next');
  });

  it('legacy graphql-ws server closes a malformed frame with 1003 and keeps serving', async () => {
    const legacy = await startLegacyGraphqlWsServer({ port: 0 });
    closers.push(legacy.close);
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(legacy.url, 'graphql-ws');
      ws.on('open', () => ws.send('{not json'));
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
    });
    expect(closeCode).toBe(1003);
    // The process survived: a well-formed handshake still works.
    const ack = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(legacy.url, 'graphql-ws');
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'connection_ack') {
          ws.close();
          resolve(msg.type);
        }
      });
      ws.on('error', reject);
    });
    expect(ack).toBe('connection_ack');
  });

  it('graphql-sse server honours `port` and streams `next` events', async () => {
    const sse = await startGraphqlSseServer({ port: 0 });
    closers.push(sse.close);
    const res = await fetch(sse.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ query: 'subscription { tick(count: 2) { n } }' }),
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body.match(/event: next/g)).toHaveLength(2);
    expect(body).toContain('event: complete');
  });

  it('legacy graphql-ws server honours `port` and acks the Apollo handshake', async () => {
    const legacy = await startLegacyGraphqlWsServer({ port: 0 });
    closers.push(legacy.close);
    const ack = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(legacy.url, 'graphql-ws');
      const timer = setTimeout(() => reject(new Error('no connection_ack')), 5_000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'connection_init' })));
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type: string };
        if (msg.type === 'connection_ack') {
          clearTimeout(timer);
          ws.close();
          resolve(msg.type);
        }
      });
      ws.on('error', reject);
    });
    expect(ack).toBe('connection_ack');
    expect(legacy.lastProtocol()).toBe('graphql-ws');
  });
});
