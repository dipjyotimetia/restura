import { test as electronTest } from './electronApp';
import { launch } from '../../echo-local/launcher';
import { PORTS } from '../../echo-local/ports';

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
}

export const test = electronTest.extend<NonNullable<unknown>, { echo: EchoLocalStack }>({
  echo: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const result = await launch({ only: new Set(['http']), tls: false });
      await use({ ports: PORTS, httpUrl: `http://${HOST}:${PORTS.http}` });
      await result.shutdown();
    },
    { scope: 'worker' },
  ],
});

export { expect } from './electronApp';
