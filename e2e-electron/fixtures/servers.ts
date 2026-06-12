import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { test as electronTest } from './electronApp';
import { startMockHttpServer, type MockHttpServerHandle } from '../../e2e/mocks/httpServer';
import { startMockWsServer, type MockWsServerHandle } from '../../e2e/mocks/wsServer';
import { startMockMcpServer, type MockMcpServerHandle } from '../../e2e/mocks/mcpServer';
import {
  startMockSocketIOServer,
  type MockSocketIOServerHandle,
} from '../../e2e/mocks/socketioServer';

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
  socketio: MockSocketIOServerHandle;
  grpc: NativeGrpcServerHandle;
}

interface ServerFixtures {
  servers: DesktopMockServers;
}

/** Worker-scoped upstreams; counters reset per test where the mocks support it. */
export const test = electronTest.extend<ServerFixtures, { _servers: DesktopMockServers }>({
  _servers: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const [http, ws, mcp, socketio, grpc] = await Promise.all([
        startMockHttpServer(),
        startMockWsServer(),
        startMockMcpServer(),
        startMockSocketIOServer(),
        startNativeGrpcServer(),
      ]);
      await use({ http, ws, mcp, socketio, grpc });
      await Promise.all([http.close(), ws.close(), mcp.close(), socketio.close(), grpc.close()]);
    },
    { scope: 'worker' },
  ],

  servers: async ({ _servers }, use) => {
    _servers.http.reset();
    _servers.ws.reset();
    _servers.mcp.reset();
    _servers.socketio.reset();
    await use(_servers);
  },
});

export { expect } from './electronApp';
