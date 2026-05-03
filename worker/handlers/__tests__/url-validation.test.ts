// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { validateURL, isPrivateAddress } from '../../shared/url-validation';

describe('validateURL', () => {
  it('valid public URL returns valid: true', () => {
    const result = validateURL('https://example.com/api');
    expect(result).toEqual({ valid: true });
  });

  it('invalid URL format returns valid: false with error', () => {
    const result = validateURL('not-a-url');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/invalid url format/i);
  });

  it('ftp:// scheme returns valid: false', () => {
    const result = validateURL('ftp://example.com/file.txt');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('localhost URL by default returns valid: false', () => {
    const result = validateURL('http://localhost:3000/api');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Localhost URLs are not allowed');
  });

  it('localhost with allowLocalhost: true returns valid: true', () => {
    const result = validateURL('http://localhost:3000/api', { allowLocalhost: true });
    expect(result.valid).toBe(true);
  });

  it('private IP http://10.0.0.1/api returns valid: false', () => {
    const result = validateURL('http://10.0.0.1/api');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/private/i);
  });

  it('private IP with allowPrivateIPs: true returns valid: true', () => {
    const result = validateURL('http://10.0.0.1/api', { allowPrivateIPs: true });
    expect(result.valid).toBe(true);
  });

  it('http://192.168.1.1/ returns valid: false', () => {
    const result = validateURL('http://192.168.1.1/');
    expect(result.valid).toBe(false);
  });

  it('http://172.16.0.1/ returns valid: false', () => {
    const result = validateURL('http://172.16.0.1/');
    expect(result.valid).toBe(false);
  });

  it('blocked hostname metadata.google.internal returns valid: false', () => {
    const result = validateURL('http://metadata.google.internal/');
    expect(result.valid).toBe(false);
  });

  it('blocked hostname 169.254.169.254 (metadata IP) returns valid: false', () => {
    const result = validateURL('http://169.254.169.254/latest/meta-data/');
    expect(result.valid).toBe(false);
  });

  it('URL with credentials returns valid: true with warnings', () => {
    const result = validateURL('https://user:pass@example.com/api');
    expect(result.valid).toBe(true);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });

  it('URL over 2048 chars returns valid: false with max length error', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2050);
    const result = validateURL(longUrl);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds maximum length/i);
  });

  it('custom maxUrlLength option is respected', () => {
    const url = 'https://example.com/' + 'a'.repeat(50);
    const result = validateURL(url, { maxUrlLength: 30 });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds maximum length/i);
  });

  it('http://kubernetes.default.svc/ returns valid: false', () => {
    const result = validateURL('http://kubernetes.default.svc/');
    expect(result.valid).toBe(false);
  });
});

describe('isPrivateAddress', () => {
  it("'localhost' returns true", () => {
    expect(isPrivateAddress('localhost')).toBe(true);
  });

  it("'127.0.0.1' returns true", () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
  });

  it("'::1' returns true", () => {
    expect(isPrivateAddress('::1')).toBe(true);
  });

  it("'10.0.0.1' returns true", () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
  });

  it("'172.16.0.1' returns true", () => {
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
  });

  it("'192.168.1.1' returns true", () => {
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
  });

  it("'169.254.1.1' returns true", () => {
    expect(isPrivateAddress('169.254.1.1')).toBe(true);
  });

  it("'8.8.8.8' returns false", () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });

  it("'1.1.1.1' returns false", () => {
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
  });

  it("'fd00::1' returns true (ULA IPv6)", () => {
    expect(isPrivateAddress('fd00::1')).toBe(true);
  });
});
