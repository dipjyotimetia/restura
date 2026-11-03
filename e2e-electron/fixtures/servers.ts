import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { type MockGrpcServerHandle, startMockGrpcServer } from '../../e2e/mocks/grpcServer';
import { type MockHttpServerHandle, startMockHttpServer } from '../../e2e/mocks/httpServer';
import { type MockMcpServerHandle, startMockMcpServer } from '../../e2e/mocks/mcpServer';
import { type MockMcpV2ServerHandle, startMockMcpV2Server } from '../../e2e/mocks/mcpV2Server';
import {
  type MockSocketIOServerHandle,
  startMockSocketIOServer,
} from '../../e2e/mocks/socketioServer';
import { type MockWsServerHandle, startMockWsServer } from '../../e2e/mocks/wsServer';
import { test as electronTest } from './electronApp';

const ROOT = path.resolve(__dirname, '../..');

export interface NativeGrpcServerHandle {
  port: number;
  /** Plaintext h2c URL the desktop transport dials. */
  url: string;
  close: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spawns `scripts/grpc-dev-server.mjs` — a REAL native gRPC server (h2c,
 * binary framing, trailers, reflection v1+v1alpha). This is what the desktop
 * ConnectRPC transport (`createGrpcTransport`) actually dials, so the smoke
 * test exercises the live wire, not a mock of it.
 */
export async function startNativeGrpcServer(): Promise<NativeGrpcServerHandle> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts/grpc-dev-server.mjs')],
    {
      env: { ...process.env, GRPC_PORT: String(port), GRPC_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('grpc dev server did not start')), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`grpc dev server exited early (code ${code})`));
    });
  });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      }),
  };
}

export interface DesktopMockServers {
  http: MockHttpServerHandle;
  ws: MockWsServerHandle;
  mcp: MockMcpServerHandle;
  mcpV2: MockMcpV2ServerHandle;
  socketio: MockSocketIOServerHandle;
  grpc: NativeGrpcServerHandle;
  /**
   * The Connect-RPC mock (`e2e/mocks/grpcServer.ts`): its `h2cUrl` speaks
   * native gRPC + Connect, and it hosts `edge.v1.EdgeService` (Any payloads,
   * a non-PascalCase method) plus a path-prefixed mount.
   */
  connectGrpc: MockGrpcServerHandle;
}

interface ServerFixtures {
  servers: DesktopMockServers;
}

/** Worker-scoped upstreams; counters reset per test where the mocks support it. */
export const test = electronTest.extend<ServerFixtures, { _servers: DesktopMockServers }>({
  _servers: [
    async ({}, use) => {
      const [http, ws, mcp, mcpV2, socketio, grpc, connectGrpc] = await Promise.all([
        startMockHttpServer(),
        startMockWsServer(),
        startMockMcpServer(),
        startMockMcpV2Server(),
        startMockSocketIOServer(),
        startNativeGrpcServer(),
        startMockGrpcServer(),
      ]);
      await use({ http, ws, mcp, mcpV2, socketio, grpc, connectGrpc });
      await Promise.all([
        connectGrpc.close(),
        http.close(),
        ws.close(),
        mcp.close(),
        mcpV2.close(),
        socketio.close(),
        grpc.close(),
      ]);
    },
    { scope: 'worker' },
  ],

  servers: async ({ _servers }, use) => {
    _servers.http.reset();
    _servers.ws.reset();
    _servers.mcp.reset();
    _servers.socketio.reset();
    _servers.connectGrpc.reset();
    await use(_servers);
  },
});

export { expect } from './electronApp';
