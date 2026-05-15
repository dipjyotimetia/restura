import { test as appTest } from './app';
import {
  startMockHttpServer,
  startMockHttpsServer,
  type MockHttpServerHandle,
} from '../mocks/httpServer';
import { startMockProxyServer, type MockProxyServerHandle } from '../mocks/proxyServer';
import { startMockGrpcServer, type MockGrpcServerHandle } from '../mocks/grpcServer';
import { startMockWsServer, type MockWsServerHandle } from '../mocks/wsServer';
import { startMockMcpServer, type MockMcpServerHandle } from '../mocks/mcpServer';
import { startMockSocketIOServer, type MockSocketIOServerHandle } from '../mocks/socketioServer';

export interface MockServers {
  http: MockHttpServerHandle;
  https: MockHttpServerHandle;
  proxy: MockProxyServerHandle;
  grpc: MockGrpcServerHandle;
  ws: MockWsServerHandle;
  mcp: MockMcpServerHandle;
  socketio: MockSocketIOServerHandle;
}

interface ServerFixtures {
  servers: MockServers;
}

/**
 * Worker-scoped fixture: one set of mock servers for the lifetime of the
 * Playwright worker. Tests get the live handles, with counters reset between
 * tests so assertions stay local. Inherits `app` from `./app` so request-tab
 * tests automatically get the onboarding-skipped page.
 */
export const test = appTest.extend<ServerFixtures, { _servers: MockServers }>({
  _servers: [
    async ({}, use) => {
      const [http, https, proxy, grpc, ws, mcp, socketio] = await Promise.all([
        startMockHttpServer(),
        startMockHttpsServer(),
        startMockProxyServer(),
        startMockGrpcServer(),
        startMockWsServer(),
        startMockMcpServer(),
        startMockSocketIOServer(),
      ]);
      await use({ http, https, proxy, grpc, ws, mcp, socketio });
      await Promise.all([
        http.close(),
        https.close(),
        proxy.close(),
        grpc.close(),
        ws.close(),
        mcp.close(),
        socketio.close(),
      ]);
    },
    { scope: 'worker' },
  ],

  servers: async ({ _servers }, use) => {
    _servers.http.reset();
    _servers.https.reset();
    _servers.proxy.reset();
    _servers.grpc.reset();
    _servers.ws.reset();
    _servers.mcp.reset();
    _servers.socketio.reset();
    await use(_servers);
  },
});

export { expect } from '@playwright/test';
