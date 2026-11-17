import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isStreamForwardDenied,
  REQUEST_DENY,
  REQUEST_DENY_MCP,
  sanitizeRequestHeaders,
  splitStreamForwardHeaders,
} from './header-policy';

const runs = { numRuns: 80 };

const headerName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,20}$/);
const headerValue = fc.string({ maxLength: 40, unit: 'grapheme' });
const headers = fc.dictionary(headerName, headerValue, { maxKeys: 8 });

describe('header policy properties', () => {
  it('sanitizeRequestHeaders is idempotent and never emits a denied name', () => {
    fc.assert(
      fc.property(headers, (input) => {
        const withDangerous = { ...input, Host: 'evil.example', cookie: 'a=b' };
        const once = sanitizeRequestHeaders(withDangerous);
        expect(sanitizeRequestHeaders(once)).toEqual(once);
        for (const key of Object.keys(once)) {
          expect(REQUEST_DENY.has(key.toLowerCase())).toBe(false);
        }
        expect(Object.keys(once).some((key) => key.toLowerCase() === 'host')).toBe(false);
        // cookie is a request header the default policy keeps and MCP must not.
        expect(once.cookie).toBe('a=b');
        const mcp = sanitizeRequestHeaders(withDangerous, 'mcp');
        expect(sanitizeRequestHeaders(mcp, 'mcp')).toEqual(mcp);
        for (const key of Object.keys(mcp)) {
          expect(REQUEST_DENY_MCP.has(key.toLowerCase())).toBe(false);
        }
      }),
      runs
    );
  });

  it('splits streamed headers so the forwarded set is stable and contains nothing denied', () => {
    fc.assert(
      fc.property(headers, (input) => {
        const withDangerous = {
          ...input,
          'Set-Cookie': 'a=b',
          Location: 'https://evil.example',
          'Content-Length': '10',
          'X-Ok': '1',
        };
        const split = splitStreamForwardHeaders(withDangerous);
        expect(splitStreamForwardHeaders(split.forward)).toEqual({
          forward: split.forward,
          withheld: {},
        });
        for (const key of Object.keys(split.forward)) {
          expect(isStreamForwardDenied(key.toLowerCase())).toBe(false);
        }
        expect(split.forward['X-Ok']).toBe('1');
        expect(split.forward.Location).toBeUndefined();
        expect(split.withheld.Location).toBe('https://evil.example');
        // Set-Cookie is denied and has its own side channel, so it is in neither map.
        expect(split.forward['Set-Cookie']).toBeUndefined();
        expect(split.withheld['Set-Cookie']).toBeUndefined();
      }),
      runs
    );
  });
});
