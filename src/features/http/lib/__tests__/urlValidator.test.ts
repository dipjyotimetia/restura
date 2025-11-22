import { describe, it, expect } from 'vitest';
import { validateURL, sanitizeURL, isLikelyPrivateHost } from '../urlValidator';

describe('URL Validator', () => {
  describe('validateURL', () => {
    it('should accept valid HTTPS URLs', () => {
      const result = validateURL('https://api.example.com/users');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid HTTP URLs', () => {
      const result = validateURL('http://api.example.com/users');
      expect(result.valid).toBe(true);
    });

    it('should reject invalid URL format', () => {
      const result = validateURL('not-a-valid-url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL format');
    });

    it('should reject file:// URLs', () => {
      const result = validateURL('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL scheme');
    });

    it('should reject ftp:// URLs', () => {
      const result = validateURL('ftp://server.com/file');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid URL scheme');
    });

    it('should reject localhost by default', () => {
      const result = validateURL('http://localhost:3000/api', {
        allowLocalhost: false,
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Localhost URLs are not allowed');
    });

    it('should allow localhost when configured', () => {
      const result = validateURL('http://localhost:3000/api', {
        allowLocalhost: true,
      });
      expect(result.valid).toBe(true);
    });

    it('should reject 127.0.0.1 when localhost not allowed', () => {
      const result = validateURL('http://127.0.0.1:8080/', {
        allowLocalhost: false,
      });
      expect(result.valid).toBe(false);
    });

    it('should reject private IP ranges (10.x.x.x)', () => {
      const result = validateURL('http://10.0.0.1/admin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private/internal IP addresses are not allowed');
    });

    it('should reject private IP ranges (192.168.x.x)', () => {
      const result = validateURL('http://192.168.1.1/admin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private/internal IP addresses are not allowed');
    });

    it('should reject private IP ranges (172.16-31.x.x)', () => {
      const result = validateURL('http://172.16.0.1/admin');
      expect(result.valid).toBe(false);
    });

    it('should allow private IPs when configured', () => {
      const result = validateURL('http://10.0.0.1/admin', {
        allowPrivateIPs: true,
      });
      expect(result.valid).toBe(true);
    });

    it('should reject AWS metadata endpoint', () => {
      const result = validateURL('http://169.254.169.254/latest/meta-data/');
      expect(result.valid).toBe(false);
    });

    it('should reject blocked hostnames', () => {
      const result = validateURL('http://metadata.google.internal/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('blocked for security reasons');
    });

    it('should reject URLs with data: in path', () => {
      const result = validateURL('https://example.com/data:text/html,<script>');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('potentially malicious content');
    });

    it('should reject URLs exceeding max length', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(3000);
      const result = validateURL(longUrl, { maxUrlLength: 2048 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds maximum length');
    });

    it('should warn about URLs with credentials', () => {
      const result = validateURL('https://user:pass@example.com/api');
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes('credentials'))).toBe(true);
    });

    it('should warn about suspicious ports', () => {
      const result = validateURL('https://example.com:3306/');
      expect(result.valid).toBe(true);
      expect(result.warnings?.some((w) => w.includes('3306'))).toBe(true);
    });

    it('should warn about IP-based URLs', () => {
      const result = validateURL('https://93.184.216.34/', {
        allowPrivateIPs: true,
      });
      expect(result.valid).toBe(true);
      expect(result.warnings?.some((w) => w.includes('IP address'))).toBe(true);
    });
  });

  describe('sanitizeURL', () => {
    it('should remove credentials from URL', () => {
      const result = sanitizeURL('https://user:password@example.com/api');
      expect(result).toBe('https://example.com/api');
      expect(result).not.toContain('user');
      expect(result).not.toContain('password');
    });

    it('should remove hash from URL', () => {
      const result = sanitizeURL('https://example.com/page#section');
      expect(result).toBe('https://example.com/page');
      expect(result).not.toContain('#');
    });

    it('should handle invalid URLs gracefully', () => {
      const result = sanitizeURL('not-a-url');
      expect(result).toBe('not-a-url');
    });

    it('should preserve path and query parameters', () => {
      const result = sanitizeURL('https://example.com/api/users?page=1&limit=10');
      expect(result).toBe('https://example.com/api/users?page=1&limit=10');
    });
  });

  describe('isLikelyPrivateHost', () => {
    it('should identify .local domains', () => {
      expect(isLikelyPrivateHost('server.local')).toBe(true);
    });

    it('should identify .internal domains', () => {
      expect(isLikelyPrivateHost('api.internal')).toBe(true);
    });

    it('should identify .lan domains', () => {
      expect(isLikelyPrivateHost('printer.lan')).toBe(true);
    });

    it('should identify intranet subdomains', () => {
      expect(isLikelyPrivateHost('intranet.company.com')).toBe(true);
    });

    it('should identify internal subdomains', () => {
      expect(isLikelyPrivateHost('internal.api.com')).toBe(true);
    });

    it('should not flag public domains', () => {
      expect(isLikelyPrivateHost('api.github.com')).toBe(false);
    });

    it('should not flag root domains', () => {
      expect(isLikelyPrivateHost('example.com')).toBe(false);
    });
  });
});
