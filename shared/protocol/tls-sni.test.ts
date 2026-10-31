import { describe, expect, it } from 'vitest';
import { tlsIdentity } from './tls-sni';

describe('tlsIdentity', () => {
  it('uses a DNS hostname as both the identity host and the SNI', () => {
    expect(tlsIdentity('api.example.com')).toEqual({
      host: 'api.example.com',
      servername: 'api.example.com',
    });
    expect(tlsIdentity('localhost')).toEqual({ host: 'localhost', servername: 'localhost' });
  });

  // Opaque (non-special scheme) hosts aren't normalised by URL; they classify
  // as DNS names, which Node 26 accepts as SNI and cert checks reject.
  it.each(['127.1', '0x7f.1'])('treats the unnormalised host %s as a DNS name', (host) => {
    expect(tlsIdentity(host)).toEqual({ host, servername: host });
  });

  // RFC 6066 forbids IP SNI; Node 26 throws ERR_INVALID_ARG_VALUE on it.
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['10.0.0.5', '10.0.0.5'],
    ['::1', '::1'],
    ['[::1]', '::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[::ffff:7f00:1]', '::ffff:7f00:1'],
  ])('omits SNI for the IP literal %s', (hostname, host) => {
    expect(tlsIdentity(hostname)).toEqual({ host });
  });
});
