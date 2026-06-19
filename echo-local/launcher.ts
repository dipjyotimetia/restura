// Boots the echo stack on the stable ports from ports.ts. Reuses the existing
// e2e/mocks factories in place (they gained an optional `port` arg) and the
// native gRPC dev server (spawned as a child, exactly like the desktop e2e
// harness). Adds the CA-signed HTTPS / mTLS listeners.
//
// Kafka and MQTT are intentionally NOT started here — they need real brokers
// (Redpanda + EMQX); the CLI prints the one-line `docker compose` hint
// instead.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { startMockHttpServer, startMockHttpsServer } from '../e2e/mocks/httpServer';
import { startMockWsServer } from '../e2e/mocks/wsServer';
import { startMockSocketIOServer } from '../e2e/mocks/socketioServer';
import { startMockMcpServer } from '../e2e/mocks/mcpServer';
import { startMockProxyServer } from '../e2e/mocks/proxyServer';
import { PORTS, TLS_SERVICES, type ServiceId } from './ports';
import type { EchoCerts } from './certs';

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

  if ((wanted('https') || wanted('mtls') || wanted('wss')) && !opts.certs) {
    throw new Error('TLS services requested but no cert material supplied');
  }

  const services: StartedService[] = [];

  if (wanted('http')) {
    const h = await startMockHttpServer({ port: PORTS.http });
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
  if (wanted('proxy')) {
    const h = await startMockProxyServer({ port: PORTS.proxy });
    services.push({ id: 'proxy', close: h.close });
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
  if (wanted('grpc')) {
    services.push(await startNativeGrpc(PORTS.grpc));
  }

  return {
    started: services.map((s) => s.id),
    shutdown: async () => {
      await Promise.allSettled(services.map((s) => s.close()));
    },
  };
}
