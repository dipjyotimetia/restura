// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { generateCurl } from '@/lib/shared/codeGenerators/curl';
import { entryToCurl } from '@/store/useConsoleStore';
import type { HttpRequest } from '@/types';

/**
 * #857 widened `HttpMethod` to any RFC 9110 token, and tchar includes shell /
 * string-interpolation metacharacters (`` ` | & $ ' # ``). Every code generator
 * that embeds the method must emit it as an inert literal — a shared or
 * imported collection must not be able to smuggle a command into a "Copy as
 * cURL" snippet the user pastes into a terminal.
 */

// Valid tokens (they pass checkHttpMethod) that are dangerous when unquoted.
const HOSTILE_METHODS = ['`id`', 'a&&b', 'GET|sh', '$HOME', "it's", 'a;b', '#{x}', '#$x', '#@x'];
// `;`, `{`, `}` are not tchar — keep only methods the policy actually accepts.
const TOKEN_METHODS = HOSTILE_METHODS.filter((m) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(m));

const request = (method: string): HttpRequest => ({
  id: 'r',
  name: 'r',
  type: 'http',
  method,
  url: 'https://api.example.com/x',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
});

/**
 * Let a real POSIX shell word-split the generated command (with `curl`
 * swapped for `printf`) and return the argument that follows `-X`. If the
 * method were unquoted, `` `id` `` would be command-substituted, `$HOME`
 * expanded, `|`/`&&` would split the pipeline, etc.
 */
function shellArgAfterX(command: string): string {
  const argv = command.replace(/^curl /, '');
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${argv}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: '/home/should-not-expand' },
  });
  const lines = out.split('\n');
  return lines[lines.indexOf('-X') + 1] ?? '';
}

describe.skipIf(process.platform === 'win32')('cURL method quoting (#857)', () => {
  it.each(TOKEN_METHODS)('generateCurl emits %j as one inert shell word', (method) => {
    const cmd = generateCurl({
      request: request(method),
      resolvedUrl: 'https://api.example.com/x',
      resolvedHeaders: {},
      resolvedParams: {},
    });
    expect(shellArgAfterX(cmd)).toBe(method);
  });

  it.each(TOKEN_METHODS)('entryToCurl emits %j as one inert shell word', (method) => {
    const cmd = entryToCurl({
      id: 'e',
      timestamp: 0,
      protocol: 'http',
      request: { method, url: 'https://api.example.com/x', headers: {} },
      response: {
        id: 'r',
        requestId: 'q',
        status: 200,
        statusText: 'OK',
        headers: {},
        body: '',
        size: 0,
        time: 1,
        timestamp: 0,
      },
    });
    expect(shellArgAfterX(cmd)).toBe(method);
  });

  it('keeps plain methods unquoted for readability', () => {
    const cmd = generateCurl({
      request: request('PROPFIND'),
      resolvedUrl: 'https://api.example.com/x',
      resolvedHeaders: {},
      resolvedParams: {},
    });
    expect(cmd).toContain('curl -X PROPFIND ');
  });
});
