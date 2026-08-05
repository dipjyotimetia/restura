import { describe, expect, it } from 'vitest';
import { buildManifest } from '../../echo-local/manifest';
import { IN_PROCESS_SERVICES, PORTS } from '../../echo-local/ports';

describe('local echo SOCKS proxy', () => {
  it('exposes the SOCKS5 proxy as an in-process service and in the generated manifest', () => {
    expect(IN_PROCESS_SERVICES).toContain('socks');
    expect(PORTS.socks).toBe(1080);

    expect(buildManifest({ host: 'localhost' }).endpoints.socksProxy).toBe(
      'socks5://localhost:1080  (SOCKS5 CONNECT)'
    );
  });
});
