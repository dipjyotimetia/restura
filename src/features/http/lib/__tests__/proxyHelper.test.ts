import { describe, it, expect } from 'vitest';
import { shouldBypassProxy } from '../proxyHelper';

describe('shouldBypassProxy', () => {
  it('returns false when bypass list is empty', () => {
    expect(shouldBypassProxy('https://api.example.com', [])).toBe(false);
  });

  it('matches exact hostname', () => {
    expect(shouldBypassProxy('https://api.example.com', ['api.example.com'])).toBe(true);
  });

  it('does not match partial hostname', () => {
    expect(shouldBypassProxy('https://api.example.com', ['example.com'])).toBe(false);
  });

  it('matches wildcard prefix', () => {
    expect(shouldBypassProxy('https://api.example.com', ['*.example.com'])).toBe(true);
  });

  it('does not match wildcard for unrelated domain', () => {
    expect(shouldBypassProxy('https://other.test.com', ['*.example.com'])).toBe(false);
  });

  it('matches glob wildcard pattern', () => {
    expect(shouldBypassProxy('https://192.168.1.1', ['192.168.*'])).toBe(true);
  });
});
