import { describe, expect, it } from 'vitest';
import { describeUrlProblem } from '../urlProblem';

describe('describeUrlProblem', () => {
  it.each([
    [''],
    ['https://example.com/a?b=1'],
    ['example.com/path'],
    ['http://localhost:8080'],
    ['{{baseUrl}}/users'],
    ['https://[::1]:3000/'],
  ])('accepts %j', (url) => {
    expect(describeUrlProblem(url)).toBeNull();
  });

  it('names spaces', () => {
    expect(describeUrlProblem('https://exa mple.com/a')).toMatch(/space/i);
    // Spaces in the path / query are percent-encoded on send, so they're fine.
    expect(describeUrlProblem('https://example.com/a b?q=x y')).toBeNull();
  });

  it('names an unsupported scheme', () => {
    expect(describeUrlProblem('ftp://example.com')).toMatch(/ftp:.*http:\/\/ or https:\/\//);
  });

  it('names a bad port', () => {
    expect(describeUrlProblem('https://example.com:99999/x')).toMatch(/port "99999"/i);
    expect(describeUrlProblem('example.com:abc')).toMatch(/port "abc"/i);
  });

  it('names a missing host', () => {
    expect(describeUrlProblem('https://')).toMatch(/host/i);
    expect(describeUrlProblem('https:///path')).toMatch(/host/i);
  });

  it('falls back to a generic hint for other malformed URLs', () => {
    expect(describeUrlProblem('https://exa[mple.com')).toMatch(/host/i);
  });
});
