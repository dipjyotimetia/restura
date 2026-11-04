// @vitest-environment node
//
// A SOCKS5 proxy password stored as a keychain handle that is gone on this
// device must fail the connection, not authenticate without it.

import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../security/secret-handle-store', () => ({
  unwrapSecretValueMain: (v: unknown): string | undefined => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'inline') {
      return (v as { value?: string }).value;
    }
    return undefined;
  },
}));

import { openSocksSocket } from '../handlers/http-secure-connection';

let server: Server;
let port: number;
const received: Array<Buffer | string> = [];

beforeAll(async () => {
  server = createServer((socket) => {
    socket.once('data', () => {
      // Greeting: require username/password auth.
      socket.write(Buffer.from([0x05, 0x02]));
      socket.on('data', (chunk) => received.push(chunk));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('openSocksSocket proxy password', () => {
  it('fails instead of connecting without a password whose handle is unavailable', async () => {
    await expect(
      openSocksSocket(
        {
          enabled: true,
          type: 'socks5',
          host: '127.0.0.1',
          port,
          auth: {
            username: 'u',
            password: { kind: 'handle', id: '00000000-0000-4000-8000-000000000000' },
          },
        } as never,
        'example.com',
        80
      )
    ).rejects.toThrow(/Proxy password is unavailable on this device/);
    expect(received).toEqual([]);
  });
});
