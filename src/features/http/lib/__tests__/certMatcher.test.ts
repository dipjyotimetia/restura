import { describe, it, expect } from 'vitest';
import { selectCertForUrl, type HostScopedEntry } from '../certMatcher';

interface Entry extends HostScopedEntry {
  id: string;
}
const e = (id: string, host: string, port?: number): Entry =>
  port === undefined ? { id, host } : { id, host, port };

describe('selectCertForUrl', () => {
  it('returns undefined for empty / missing entries', () => {
    expect(selectCertForUrl('https://example.com', undefined)).toBeUndefined();
    expect(selectCertForUrl('https://example.com', [])).toBeUndefined();
  });

  it('returns undefined for an unparseable URL', () => {
    expect(selectCertForUrl('not a url', [e('1', 'example.com')])).toBeUndefined();
  });

  it('matches an exact host', () => {
    expect(selectCertForUrl('https://api.example.com/x', [e('1', 'api.example.com')])?.id).toBe(
      '1'
    );
    expect(selectCertForUrl('https://other.com', [e('1', 'api.example.com')])).toBeUndefined();
  });

  it('matches wildcard *.example.com including the apex', () => {
    const list = [e('1', '*.example.com')];
    expect(selectCertForUrl('https://sub.example.com', list)?.id).toBe('1');
    expect(selectCertForUrl('https://example.com', list)?.id).toBe('1');
    expect(selectCertForUrl('https://notexample.com', list)).toBeUndefined();
  });

  it('matches a leading-dot suffix', () => {
    expect(selectCertForUrl('https://a.b.example.com', [e('1', '.example.com')])?.id).toBe('1');
  });

  it('honours an optional port qualifier', () => {
    const list = [e('1', 'example.com', 8443)];
    expect(selectCertForUrl('https://example.com:8443', list)?.id).toBe('1');
    expect(selectCertForUrl('https://example.com', list)).toBeUndefined(); // default 443 != 8443
  });

  it('defaults the port from the scheme', () => {
    expect(selectCertForUrl('https://example.com', [e('1', 'example.com', 443)])?.id).toBe('1');
    expect(selectCertForUrl('http://example.com', [e('1', 'example.com', 80)])?.id).toBe('1');
  });

  it('prefers an exact host over a wildcard', () => {
    const list = [e('wild', '*.example.com'), e('exact', 'api.example.com')];
    expect(selectCertForUrl('https://api.example.com', list)?.id).toBe('exact');
  });

  it('prefers a port-pinned entry over an any-port entry at equal host specificity', () => {
    const list = [e('any', 'example.com'), e('pinned', 'example.com', 443)];
    expect(selectCertForUrl('https://example.com', list)?.id).toBe('pinned');
  });

  it('breaks ties on longer (more-specific) host pattern', () => {
    const list = [e('short', '*.com'), e('long', '*.example.com')];
    expect(selectCertForUrl('https://api.example.com', list)?.id).toBe('long');
  });

  it('returns undefined when nothing matches', () => {
    expect(selectCertForUrl('https://example.com', [e('1', 'other.com', 443)])).toBeUndefined();
  });
});
