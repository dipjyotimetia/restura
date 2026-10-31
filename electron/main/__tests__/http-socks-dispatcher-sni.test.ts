// @vitest-environment node

import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what the SOCKS connector hands tls.connect — the identity options
// aren't observable through a live handshake with verification disabled.
const tlsConnect = vi.fn((_opts: Record<string, unknown>) => new EventEmitter());
vi.mock('node:tls', () => ({ connect: (opts: Record<string, unknown>) => tlsConnect(opts) }));

const agentOptions: { connect?: (opts: unknown, cb: () => void) => void }[] = [];
vi.mock('undici', () => ({
  Agent: class {
    constructor(opts: (typeof agentOptions)[number]) {
      agentOptions.push(opts);
    }
  },
}));

import { createSocksDispatcher } from '../handlers/http-socks-dispatcher';
import type { HttpVersionPlan } from '../handlers/http-version';

const PLAN: HttpVersionPlan = {
  allowH2: false,
  preferH2: false,
  requireH2: false,
  h2cPriorKnowledge: false,
};

function tlsOptionsFor(url: string): Record<string, unknown> {
  createSocksDispatcher(
    new EventEmitter() as unknown as net.Socket,
    new URL(url),
    true,
    true,
    PLAN
  );
  agentOptions.at(-1)?.connect?.({}, () => {});
  const opts = tlsConnect.mock.calls.at(-1)?.[0];
  if (!opts) throw new Error('tls.connect was not called');
  return opts;
}

beforeEach(() => {
  tlsConnect.mockClear();
  agentOptions.length = 0;
});

describe('createSocksDispatcher TLS identity', () => {
  it('sends SNI and checks the cert against a DNS hostname', () => {
    expect(tlsOptionsFor('https://api.example.com/')).toMatchObject({
      host: 'api.example.com',
      servername: 'api.example.com',
    });
  });

  // Node 26 throws on IP SNI. `host` must still be set: without it the socket's
  // dial host (the SOCKS proxy) would become the certificate identity.
  it.each([
    ['https://93.184.216.34/', '93.184.216.34'],
    ['https://[2001:db8::1]/', '2001:db8::1'],
  ])('omits SNI but keeps the identity host for %s', (url, host) => {
    const opts = tlsOptionsFor(url);
    expect(opts).not.toHaveProperty('servername');
    expect(opts).toMatchObject({ host });
  });
});
