import { describe, expect, it } from 'vitest';
import { registryTransportWarning } from '../registryTransport';

describe('registryTransportWarning', () => {
  it('stays quiet for HTTPS, credential-less, loopback and private registries', () => {
    expect(
      registryTransportWarning({ url: 'https://r.example.com', authType: 'bearer' })
    ).toBeNull();
    expect(registryTransportWarning({ url: 'http://r.example.com' })).toBeNull();
    expect(
      registryTransportWarning({ url: 'http://r.example.com', auth: { username: ' ' } })
    ).toBeNull();
    for (const url of [
      'http://localhost:8081',
      'http://reg.localhost',
      'http://127.0.0.1:8081',
      'http://10.0.0.4',
      'http://[::1]:8081',
    ]) {
      expect(registryTransportWarning({ url, authType: 'bearer' })).toBeNull();
    }
    expect(registryTransportWarning({ url: 'not a url', authType: 'bearer' })).toBeNull();
  });

  it('warns that public literal addresses are refused', () => {
    expect(
      registryTransportWarning({ url: 'http://93.184.216.34:8081', authType: 'bearer' })
    ).toMatch(/not sent over plain HTTP to a public address/);
    expect(
      registryTransportWarning({
        url: 'http://[2001:db8::1]:8081',
        auth: { username: 'u' },
      })
    ).toMatch(/public address/);
  });

  it('explains that hostnames must resolve to a private network', () => {
    expect(
      registryTransportWarning({ url: 'http://schema-registry:8081', auth: { username: 'u' } })
    ).toMatch(/only sent if schema-registry resolves to a loopback or private-network address/);
  });
});
