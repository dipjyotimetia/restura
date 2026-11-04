import { describe, expect, it } from 'vitest';
import { isProxyBypassed } from './proxy-bypass';

describe('isProxyBypassed', () => {
  it.each([
    ['api.example.com', ['api.example.com'], true],
    ['API.Example.com', ['api.example.COM'], true],
    ['a.example.com', ['*.example.com'], true],
    ['example.com', ['*.example.com'], true],
    ['badexample.com', ['*.example.com'], false],
    ['api1.example.com', ['api*.example.com'], true],
    ['apiXexampleYcom', ['api.example.com'], false],
    ['[::1]', ['::1'], true],
    ['[::1]', ['[::1]'], true],
    ['::1', ['[::1]'], true],
    ['[::1]', ['::2'], false],
    ['host', ['', '  '], false],
  ])('%s against %j → %s', (host, list, expected) => {
    expect(isProxyBypassed(host, list)).toBe(expected);
  });
});
