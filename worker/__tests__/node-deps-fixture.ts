/**
 * The self-host Node composition of `createApp` deps, minus the WebSocket
 * upgrade (which needs a live server). Mirrors `worker/node-entry.ts`.
 */
import type { AppDeps } from '../adapters';
import { createNodeGuardedFetch } from '../shared/guarded-fetch-node';
import { createHttpsViaConnectProxy, createHttpViaProxy } from '../shared/tcp-proxy-node';

export const NODE_DEPS_FOR_TEST: AppDeps = {
  tcpProxy: {
    httpsViaConnectProxy: createHttpsViaConnectProxy({}),
    httpViaProxy: createHttpViaProxy({}),
  },
  websocketHandler: async (c) => c.text('ws'),
  nodeFetch: createNodeGuardedFetch(),
};
