// Boots the echo stack on the stable ports from ports.ts. Reuses the existing
// e2e/mocks factories in place (they gained an optional `port` arg) and the
// native gRPC dev server (spawned as a child, exactly like the desktop e2e
// harness). Adds the CA-signed HTTPS / mTLS listeners.
//
// Kafka and MQTT are intentionally NOT started here — they need real brokers
// (Redpanda + EMQX); the CLI prints the one-line `docker compose` hint
// instead.

import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  startGraphqlSseServer,
  startLegacyGraphqlWsServer,
} from '../e2e/mocks/graphqlSubscriptionServers';
import { startMockHttp2Server } from '../e2e/mocks/http2Server';
import {
  type MockHttpServerHandle,
  startMockHttpServer,
  startMockHttpsServer,
} from '../e2e/mocks/httpServer';
import { startMockOAuthServer } from '../e2e/mocks/mcpOAuthServer';
import { startMockMcpServer } from '../e2e/mocks/mcpServer';
import { startMockMcpV2Server } from '../e2e/mocks/mcpV2Server';
import { startMockProxyServer } from '../e2e/mocks/proxyServer';
import { startMockSocketIOServer } from '../e2e/mocks/socketioServer';
import { startMockSocksProxyServer } from '../e2e/mocks/socksProxyServer';
import { startMockWsServer } from '../e2e/mocks/wsServer';
import type { EchoCerts } from './certs';
import { PORTS, type ServiceId, TLS_SERVICES } from './ports';

export interface StartedService {
  id: ServiceId;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  /** Restrict to these services; default = all in-process services. */
  only?: ReadonlySet<ServiceId>;
  /** Disable TLS (skips https/mtls; MQTT keeps its plaintext listener). */
  tls: boolean;
  /** Cert material — required when TLS is enabled. */
  certs?: EchoCerts | undefined;
}

export interface LaunchResult {
  started: ServiceId[];
  /** Present when the local HTTP echo service was started. */
  http?: MockHttpServerHandle;
  shutdown: () => Promise<void>;
}

/** Spawn the native gRPC dev server (h2c + reflection) on a fixed port. */
function startNativeGrpc(port: number): Promise<StartedService> {
  const script = resolve(process.cwd(), 'scripts/grpc-dev-server.mjs');
  const child: ChildProcess = spawn(process.execPath, [script], {
    env: { ...process.env, GRPC_PORT: String(port), GRPC_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise<StartedService>((resolveStart, reject) => {
    const timer = setTimeout(
      () => reject(new Error('gRPC dev server did not start in time')),
      15_000
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Listening')) {
        clearTimeout(timer);
        resolveStart({
          id: 'grpc',
          close: () =>
            new Promise<void>((done) => {
              child.once('exit', () => done());
              child.kill('SIGTERM');
              setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
            }),
        });
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gRPC dev server exited early (code ${code})`));
    });
  });
}

export async function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const wanted = (id: ServiceId): boolean => {
    if (opts.only && !opts.only.has(id)) return false;
    if (!opts.tls && TLS_SERVICES.has(id)) return false;
    return true;
  };

  if ((wanted('https') || wanted('mtls') || wanted('h2') || wanted('wss')) && !opts.certs) {
    throw new Error('TLS services requested but no cert material supplied');
  }

  const services: StartedService[] = [];
  let http: MockHttpServerHandle | undefined;

  if (wanted('http')) {
    const h = await startMockHttpServer({ port: PORTS.http });
    http = h;
    services.push({ id: 'http', close: h.close });
  }
  if (wanted('https') && opts.certs) {
    const h = await startMockHttpsServer({
      port: PORTS.https,
      tls: { key: opts.certs.serverKey, cert: opts.certs.serverCert },
    });
    services.push({ id: 'https', close: h.close });
  }
  if (wanted('mtls') && opts.certs) {
    const h = await startMockHttpsServer({
      port: PORTS.mtls,
      tls: { key: opts.certs.serverKey, cert: opts.certs.serverCert, ca: opts.certs.caPem },
      requestCert: true,
    });
    services.push({ id: 'mtls', close: h.close });
  }
  if (wanted('h2c')) {
    const h = await startMockHttp2Server({ port: PORTS.h2c });
    services.push({ id: 'h2c', close: h.close });
  }
  if (wanted('h2') && opts.certs) {
    const h = await startMockHttp2Server({
      port: PORTS.h2,
      tls: { key: opts.certs.serverKey, cert: opts.certs.serverCert },
    });
    services.push({ id: 'h2', close: h.close });
  }
  if (wanted('proxy')) {
    const h = await startMockProxyServer({ port: PORTS.proxy });
    services.push({ id: 'proxy', close: h.close });
  }
  if (wanted('socks')) {
    const h = await startMockSocksProxyServer({ port: PORTS.socks });
    services.push({ id: 'socks', close: h.close });
  }
  if (wanted('ws')) {
    const h = await startMockWsServer({ port: PORTS.ws });
    services.push({ id: 'ws', close: h.close });
  }
  if (wanted('wss') && opts.certs) {
    const h = await startMockWsServer({
      port: PORTS.wss,
      tls: { key: opts.certs.serverKey, cert: opts.certs.serverCert },
    });
    services.push({ id: 'wss', close: h.close });
  }
  if (wanted('socketio')) {
    const h = await startMockSocketIOServer({ port: PORTS.socketio });
    services.push({ id: 'socketio', close: h.close });
  }
  if (wanted('mcp')) {
    const h = await startMockMcpServer({ port: PORTS.mcp });
    services.push({ id: 'mcp', close: h.close });
  }
  if (wanted('mcpV2')) {
    const h = await startMockMcpV2Server({ port: PORTS.mcpV2 });
    services.push({ id: 'mcpV2', close: h.close });
  }
  if (wanted('mcpOAuth')) {
    // Authorization server first: the protected resource advertises its URL in
    // the RFC 9728 document and validates the tokens it issued.
    const as = await startMockOAuthServer({
      port: PORTS.mcpOAuthAs,
      scopesSupported: ['mcp:tools'],
    });
    const resource = await startMockMcpServer({
      port: PORTS.mcpOAuthResource,
      oauth: {
        isAuthorized: (authorization) => {
          const m = /^Bearer\s+(.+)$/.exec(authorization);
          return m !== null && as.isValidAccessToken(m[1]!);
        },
        authorizationServers: [as.url],
        scopesSupported: ['mcp:tools'],
      },
    });
    services.push({
      id: 'mcpOAuth',
      close: async () => {
        await Promise.allSettled([resource.close(), as.close()]);
      },
    });
  }
  if (wanted('graphqlSse')) {
    const h = await startGraphqlSseServer({ port: PORTS.graphqlSse });
    services.push({ id: 'graphqlSse', close: h.close });
  }
  if (wanted('graphqlWsLegacy')) {
    const h = await startLegacyGraphqlWsServer({ port: PORTS.graphqlWsLegacy });
    services.push({ id: 'graphqlWsLegacy', close: h.close });
  }
  if (wanted('grpc')) {
    services.push(await startNativeGrpc(PORTS.grpc));
  }

  return {
    started: services.map((s) => s.id),
    http,
    shutdown: async () => {
      await Promise.allSettled(services.map((s) => s.close()));
    },
  };
}
