import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { McpRequest, SseRequest } from '@/types';
import { generateGraphQLCurl } from './graphql';
import { mcpCodeGenerators } from './mcp';
import { sseCodeGenerators } from './sse';

// Every curl-like generator must emit a command a POSIX shell passes to curl
// verbatim: no `$( )` / backtick substitution, no broken single quotes. Swap
// `curl` for `printf` and let a real `sh` tell us which argv curl would get.
const HOSTILE = `it's $(echo pwned) \`echo pwned\` "q" $HOME`;

function argvOf(command: string): string[] {
  expect(command.startsWith('curl ')).toBe(true);
  const out = execFileSync('sh', ['-c', `printf '%s\\0' ${command.slice('curl '.length)}`], {
    encoding: 'utf8',
  });
  return out.split('\0').slice(0, -1);
}

describe('curl-like generators quote with escapeShell', () => {
  it('GraphQL', () => {
    const query = `query { field(arg: "${HOSTILE}") }`;
    const argv = argvOf(
      generateGraphQLCurl({
        url: `https://api.test/graphql?q=${HOSTILE}`,
        query,
        headers: { 'X-Note': HOSTILE },
      })
    );
    expect(argv).toContain(`https://api.test/graphql?q=${HOSTILE}`);
    expect(argv).toContain(`X-Note: ${HOSTILE}`);
    const dataIndex = argv.indexOf('--data-raw');
    expect(dataIndex).toBeGreaterThan(-1);
    expect(JSON.parse(argv[dataIndex + 1] ?? '')).toEqual({ query, variables: {} });
  });

  it('SSE', () => {
    const request: SseRequest = {
      id: 's',
      name: 's',
      type: 'sse',
      url: `https://api.test/events?q=${HOSTILE}`,
      headers: [{ id: 'h', key: 'X-Note', value: HOSTILE, enabled: true }],
      params: [],
      auth: { type: 'none' },
    };
    const argv = argvOf(sseCodeGenerators.curl.generate({ request }));
    expect(argv).toContain(`https://api.test/events?q=${HOSTILE}`);
    expect(argv).toContain(`X-Note: ${HOSTILE}`);
  });

  it('MCP', () => {
    const request: McpRequest = {
      id: 'm',
      name: 'm',
      type: 'mcp',
      url: `https://mcp.test/mcp?q=${HOSTILE}`,
      transport: 'streamable-http',
      headers: [{ id: 'h', key: 'X-Note', value: HOSTILE, enabled: true }],
      auth: { type: 'none' },
    };
    const argv = argvOf(
      mcpCodeGenerators.curl.generate({ request, method: 'tools/call', params: { note: HOSTILE } })
    );
    expect(argv).toContain(`https://mcp.test/mcp?q=${HOSTILE}`);
    expect(argv).toContain(`X-Note: ${HOSTILE}`);
    const dataIndex = argv.indexOf('--data-raw');
    expect(dataIndex).toBeGreaterThan(-1);
    expect(JSON.parse(argv[dataIndex + 1] ?? '')).toMatchObject({
      method: 'tools/call',
      params: { note: HOSTILE },
    });
  });
});
