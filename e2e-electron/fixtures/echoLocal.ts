import type { MockHttpServerHandle } from '../../e2e/mocks/httpServer';
import { launch } from '../../echo-local/launcher';
import { PORTS } from '../../echo-local/ports';
import { test as electronTest } from './electronApp';

/**
 * Boots the echo-local stack (the same `launch()` the `npm run echo:local` CLI
 * uses) on its stable ports, so the desktop suite can drive REAL flows the
 * ephemeral `e2e/mocks` fixture in `servers.ts` doesn't expose — notably the
 * full HTTP auth surface (basic/bearer/apikey/awsv4/…) the echo server verifies.
 *
 * Scoped to `http` only (no TLS, no spawned gRPC child) because that's all the
 * current consumers need. Widen `only` / pass `tls:true` + `ensureCerts()` when
 * a spec needs the HTTPS / mTLS / proxy listeners. Kafka/MQTT stay Docker-gated.
 */
const HOST = 'localhost';

export interface EchoLocalStack {
  ports: typeof PORTS;
  /** Plain HTTP echo + the full auth surface (basic/bearer/apikey/awsv4/…). */
  httpUrl: string;
  /** Request recorder for asserting the wire payload sent to Echo Local. */
  http: MockHttpServerHandle;
}

export const test = electronTest.extend<NonNullable<unknown>, { echo: EchoLocalStack }>({
  echo: [
    async ({}, use) => {
      const result = await launch({ only: new Set(['http']), tls: false });
      if (!result.http) throw new Error('Echo Local HTTP service did not start');
      await use({ ports: PORTS, httpUrl: `http://${HOST}:${PORTS.http}`, http: result.http });
      await result.shutdown();
    },
    { scope: 'worker' },
  ],
});

export { expect } from './electronApp';
