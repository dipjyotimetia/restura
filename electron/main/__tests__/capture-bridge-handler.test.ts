import { describe, expect, it } from 'vitest';
import {
  bridgePayloadSchema,
  isAuthorized,
  isLoopbackRequest,
} from '../handlers/capture-bridge-protocol';

const TOKEN = 'a'.repeat(43);

describe('isAuthorized', () => {
  it('accepts the exact bearer token', () => {
    expect(isAuthorized({ authorization: `Bearer ${TOKEN}` }, TOKEN)).toBe(true);
  });
  it('rejects a missing token', () => {
    expect(isAuthorized({}, TOKEN)).toBe(false);
  });
  it('rejects a wrong token', () => {
    expect(isAuthorized({ authorization: 'Bearer nope' }, TOKEN)).toBe(false);
  });
  it('rejects when no token is configured', () => {
    expect(isAuthorized({ authorization: `Bearer ${TOKEN}` }, '')).toBe(false);
  });
});

describe('isLoopbackRequest', () => {
  it('accepts a loopback host header and no origin', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:7321' })).toBe(true);
  });
  it('accepts a chrome-extension origin', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:7321', origin: 'chrome-extension://abcdef' })).toBe(
      true
    );
  });
  it('rejects a remote web origin (DNS-rebind / CSRF defence)', () => {
    expect(isLoopbackRequest({ host: '127.0.0.1:7321', origin: 'http://evil.com' })).toBe(false);
  });
  it('rejects a non-loopback host', () => {
    expect(isLoopbackRequest({ host: 'evil.com' })).toBe(false);
  });
});

describe('bridgePayloadSchema', () => {
  it('accepts a minimal valid session', () => {
    const parsed = bridgePayloadSchema.safeParse({
      session: {
        id: 's1',
        createdAt: 0,
        exchanges: [
          {
            id: '1',
            protocol: 'rest',
            method: 'GET',
            url: 'https://api.example.com/x',
            startedAt: 0,
            request: { headers: [] },
          },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a malformed session', () => {
    expect(bridgePayloadSchema.safeParse({ session: { id: 's1' } }).success).toBe(false);
  });

  it('rejects an unknown protocol', () => {
    const parsed = bridgePayloadSchema.safeParse({
      session: {
        id: 's1',
        createdAt: 0,
        exchanges: [
          {
            id: '1',
            protocol: 'telnet',
            method: 'GET',
            url: 'x',
            startedAt: 0,
            request: { headers: [] },
          },
        ],
      },
    });
    expect(parsed.success).toBe(false);
  });
});
