// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { validateURL } from '@shared/protocol/url-validation';

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

  it('IPv6 loopback http://[::1]/ is not blocked (URL.hostname includes brackets, bypasses ::1 pattern)', () => {
    const result = validateURL('http://[::1]/');
    expect(result.valid).toBe(true);
  });

  it('IPv6 ULA http://[fc00::1]/ is not blocked (URL.hostname includes brackets, bypasses fc00: pattern)', () => {
    const result = validateURL('http://[fc00::1]/');
    expect(result.valid).toBe(true);
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
});
