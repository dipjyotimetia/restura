import * as diagnosticsChannel from 'node:diagnostics_channel';
import { describe, expect, it } from 'vitest';
import { subscribeProxyAlpnCapture } from '../handlers/http-proxy-alpn';

const channel = diagnosticsChannel.channel('undici:client:connected');

function publish(connectParams: Record<string, unknown>, alpnProtocol: string): void {
  channel.publish({ connectParams, socket: { alpnProtocol } });
}

describe('subscribeProxyAlpnCapture', () => {
  it('matches undici string ports, including "" for the scheme default', () => {
    const holder: { alpn?: string } = {};
    const off = subscribeProxyAlpnCapture('api.example', 443, holder);
    publish({ hostname: 'api.example', protocol: 'https:', port: '' }, 'h2');
    off();
    expect(holder.alpn).toBe('h2');

    const explicit: { alpn?: string } = {};
    const off2 = subscribeProxyAlpnCapture('api.example', 8443, explicit);
    publish({ hostname: 'api.example', protocol: 'https:', port: '8443' }, 'http/1.1');
    off2();
    expect(explicit.alpn).toBe('http/1.1');
  });

  it('matches bracketed IPv6 URL hostnames against undici’s unbracketed form', () => {
    const holder: { alpn?: string } = {};
    const off = subscribeProxyAlpnCapture('[::1]', 8443, holder);
    publish({ hostname: '::1', protocol: 'https:', port: '8443' }, 'h2');
    off();
    expect(holder.alpn).toBe('h2');
  });

  it('ignores connections to other hosts or ports, and stops after unsubscribe', () => {
    const holder: { alpn?: string } = {};
    const off = subscribeProxyAlpnCapture('api.example', 443, holder);
    publish({ hostname: 'other.example', protocol: 'https:', port: '' }, 'h2');
    publish({ hostname: 'api.example', protocol: 'https:', port: '8443' }, 'h2');
    off();
    off();
    publish({ hostname: 'api.example', protocol: 'https:', port: '' }, 'h2');
    expect(holder.alpn).toBeUndefined();
  });
});
