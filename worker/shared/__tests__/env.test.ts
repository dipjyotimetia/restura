import { describe, expect, it } from 'vitest';
import type { Env } from '../../env';
import { nodeDnsGuardOptions } from '../env';

const env = (vars: Record<string, string | undefined>) => vars as unknown as Env;

describe('nodeDnsGuardOptions (self-host process-level DNS guard)', () => {
  it('does NOT allow localhost on ENVIRONMENT=development alone', () => {
    // A self-host with ENVIRONMENT=development + WORKER_PROXY_TOKEN must not let an
    // authenticated caller dial loopback via upstreamProxy / WebSocket.
    expect(nodeDnsGuardOptions(env({ ENVIRONMENT: 'development' })).allowLocalhost).toBe(false);
  });

  it('allows localhost only with the same gate as isLocalDevBypass', () => {
    expect(
      nodeDnsGuardOptions(env({ ENVIRONMENT: 'development', DEV_BYPASS_AUTH: 'true' }))
        .allowLocalhost
    ).toBe(true);
    expect(
      nodeDnsGuardOptions(env({ ENVIRONMENT: 'production', DEV_BYPASS_AUTH: 'true' }))
        .allowLocalhost
    ).toBe(false);
  });

  it('maps ALLOW_PRIVATE_IPS', () => {
    expect(nodeDnsGuardOptions(env({ ALLOW_PRIVATE_IPS: 'true' })).allowPrivateIPs).toBe(true);
    expect(nodeDnsGuardOptions(env({ ALLOW_PRIVATE_IPS: '1' })).allowPrivateIPs).toBe(false);
  });
});
