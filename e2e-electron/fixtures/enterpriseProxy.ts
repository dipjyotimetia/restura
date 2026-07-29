import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MockHttpServerHandle } from '../../e2e/mocks/httpServer';
import { ensureCerts } from '../../echo-local/certs';
import {
  ENTERPRISE_PROXY_PASSWORD,
  ENTERPRISE_PROXY_USERNAME,
  type EnterpriseProxyStack,
} from '../../echo-local/enterprise-proxy';
import { launch } from '../../echo-local/launcher';
import { PORTS } from '../../echo-local/ports';
import { test as electronTest } from './electronApp';

export const ENTERPRISE_POLICY_PATH = '/tmp/restura-enterprise-e2e/policy.json';
export const ENTERPRISE_POLICY_AVAILABLE = existsSync(ENTERPRISE_POLICY_PATH);

export interface EnterpriseEchoStack {
  http: MockHttpServerHandle;
  proxy: EnterpriseProxyStack;
  urls: {
    http: string;
    socksHttp: string;
    graphql: string;
    sse: string;
    mcp: string;
    wss: string;
    socketio: string;
    grpc: string;
    ai: string;
  };
}

export const test = electronTest.extend<
  NonNullable<unknown>,
  { enterpriseEcho: EnterpriseEchoStack }
>({
  ignoreCertificateErrors: [false, { scope: 'worker' }],
  enterpriseEcho: [
    async ({}, use) => {
      const certs = ensureCerts({ dir: path.resolve('echo-local/certs') });
      const result = await launch({
        only: new Set(['http', 'wss', 'socketio', 'mcp', 'grpc', 'enterprise-proxy']),
        tls: true,
        certs,
      });
      if (!result.http || !result.enterpriseProxy) {
        throw new Error('Enterprise Echo Local services did not start');
      }
      await use({
        http: result.http,
        proxy: result.enterpriseProxy,
        urls: {
          http: `http://localhost:${PORTS.http}`,
          socksHttp: `http://socks-target.localhost:${PORTS.http}`,
          graphql: `http://localhost:${PORTS.http}/graphql`,
          sse: `http://localhost:${PORTS.http}/stream/sse`,
          mcp: `http://localhost:${PORTS.mcp}/mcp`,
          wss: `wss://localhost:${PORTS.wss}/echo`,
          socketio: `http://localhost:${PORTS.socketio}`,
          grpc: `grpc://localhost:${PORTS.grpc}`,
          ai: `http://localhost:${PORTS.http}`,
        },
      });
      await result.shutdown();
    },
    { scope: 'worker' },
  ],

  electronEnv: [
    async ({ enterpriseEcho: _enterpriseEcho }, use) => {
      await use({
        RESTURA_ENTERPRISE_POLICY_FILE: ENTERPRISE_POLICY_PATH,
        RESTURA_E2E_PROXY_USERNAME: ENTERPRISE_PROXY_USERNAME,
        RESTURA_E2E_PROXY_PASSWORD: ENTERPRISE_PROXY_PASSWORD,
      });
    },
    { scope: 'worker' },
  ],
});

export { expect } from './electronApp';
