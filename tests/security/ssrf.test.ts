// @vitest-environment node

import { validateURL } from '@shared/protocol/url-validation';
import { describe, expect, it } from 'vitest';

describe('SSRF protection', () => {
  it('AWS metadata endpoint is blocked', () => {
    const result = validateURL('http://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
  });

  it('GCP metadata endpoint is blocked', () => {
    const result = validateURL('http://metadata.google.internal/');
    expect(result.valid).toBe(false);
  });

  it('Kubernetes API endpoint is blocked', () => {
    const result = validateURL('http://kubernetes.default/');
    expect(result.valid).toBe(false);
  });

  it('IPv6 loopback http://[::1]/ is blocked', () => {
    const result = validateURL('http://[::1]/');
    expect(result.valid).toBe(false);
  });

  it('IPv6 ULA http://[fc00::1]/ is blocked', () => {
    const result = validateURL('http://[fc00::1]/');
    expect(result.valid).toBe(false);
  });

  it('http://0.0.0.0/ is blocked', () => {
    const result = validateURL('http://0.0.0.0/');
    expect(result.valid).toBe(false);
  });

  it('javascript:// scheme is blocked (not in allowed schemes)', () => {
    const result = validateURL('javascript://evil.com');
    expect(result.valid).toBe(false);
  });

  it('valid public URL passes', () => {
    const result = validateURL('https://api.example.com/v1/resource');
    expect(result.valid).toBe(true);
  });

  it('allowPrivateIPs: true allows private addresses', () => {
    const result = validateURL('http://10.0.0.1/internal', { allowPrivateIPs: true });
    expect(result.valid).toBe(true);
  });

  // Broker/registry guards pass allowPrivateIPs:true (RFC1918 brokers are legit),
  // but the cloud-metadata endpoint must stay blocked — including the trailing-dot
  // and IPv4-mapped-IPv6 forms that previously evaded the exact-string blocklist.
  it('metadata IP stays blocked even when allowPrivateIPs is set', () => {
    expect(validateURL('http://169.254.169.254/', { allowPrivateIPs: true }).valid).toBe(false);
  });

  it('trailing-dot metadata hostname does not bypass the blocklist', () => {
    expect(validateURL('http://metadata.google.internal./', { allowPrivateIPs: true }).valid).toBe(
      false
    );
  });

  it('IPv4-mapped-IPv6 metadata address is blocked even with allowPrivateIPs', () => {
    expect(validateURL('http://[::ffff:169.254.169.254]/', { allowPrivateIPs: true }).valid).toBe(
      false
    );
  });
});
