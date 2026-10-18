import { describe, expect, it } from 'vitest';
import { internalToOC } from '../../opencollection/from-internal';
import { ocToInternal } from '../../opencollection/to-internal';
import type { Collection, McpRequest } from '../../types';
import { redactCollectionSecrets } from '../collection-redaction';
import { redactMcpCollectionCredentials, redactMcpCredentials } from '../mcp-credential-redaction';

const TOKEN = 'mcp-plaintext-token-123';
const API_KEY = 'mcp-plaintext-key-456';

function mcpRequest(overrides: Partial<McpRequest> = {}): McpRequest {
  return {
    id: 'r1',
    name: 'MCP',
    type: 'mcp',
    url: 'https://mcp.example.com/mcp',
    transport: 'streamable-http',
    headers: [
      { id: 'h1', key: 'Authorization', value: `Bearer ${TOKEN}`, enabled: true },
      { id: 'h2', key: 'X-Tenant', value: 'acme', enabled: true },
      { id: 'h3', key: 'X-Custom', value: API_KEY, enabled: true, secret: true },
    ],
    auth: { type: 'bearer', bearer: { token: { kind: 'inline', value: TOKEN } } },
    ...overrides,
  };
}

/** An OpenCollection document whose MCP extension entry carries credentials. */
function ocWithMcpCredentials() {
  return {
    opencollection: '1.0.0',
    info: { name: 'Creds' },
    items: [
      {
        info: { name: 'Http', type: 'http' },
        http: { method: 'GET', url: 'https://api.example.com' },
      },
    ],
    extensions: {
      'x-restura-mcp': [
        {
          info: { type: 'mcp', name: 'Remote MCP' },
          mcp: {
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            headers: [
              { name: 'Authorization', value: `Bearer ${TOKEN}` },
              { name: 'X-Tenant', value: 'acme' },
            ],
            auth: { type: 'apikey', key: 'X-API-Key', value: API_KEY, placement: 'header' },
          },
        },
      ],
    },
  };
}

describe('redactMcpCredentials (#896)', () => {
  it('blanks credential headers and inline auth, keeps shape and non-secret rows', () => {
    const out = redactMcpCredentials(mcpRequest());
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(JSON.stringify(out)).not.toContain(API_KEY);
    expect(out.headers.map((h) => [h.key, h.value])).toEqual([
      ['Authorization', ''],
      ['X-Tenant', 'acme'],
      ['X-Custom', ''],
    ]);
    expect(out.auth).toEqual({ type: 'bearer', bearer: { token: { kind: 'inline', value: '' } } });
  });

  it('preserves SecretRef handles (opaque ids, no plaintext)', () => {
    const out = redactMcpCredentials(
      mcpRequest({
        headers: [],
        auth: { type: 'bearer', bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } } },
      })
    );
    expect(out.auth).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } },
    });
  });

  it('does not mutate the input and tolerates a connection without auth', () => {
    const input = { headers: [{ key: 'Authorization', value: 'Bearer x', enabled: true }] };
    const out = redactMcpCredentials(input);
    expect(input.headers[0]?.value).toBe('Bearer x');
    expect(out.headers[0]?.value).toBe('');
    expect('auth' in out).toBe(false);
  });
});

describe('redactMcpCollectionCredentials (web persistence)', () => {
  it('blanks typed MCP fields, item bags and root x-restura-mcp entries', () => {
    const imported = ocToInternal(ocWithMcpCredentials() as never);
    expect(JSON.stringify(imported)).toContain(TOKEN);

    const out = redactMcpCollectionCredentials(imported);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(API_KEY);
    // Shape survives — the user re-enters the credential.
    const mcp = out.items.find((i) => i.request?.type === 'mcp')?.request as McpRequest;
    expect(mcp.headers.map((h) => h.key)).toEqual(['Authorization', 'X-Tenant']);
    expect(mcp.auth.type).toBe('api-key');
  });

  it('redacts MCP requests nested in folders and leaves other requests untouched', () => {
    const collection: Collection = {
      id: 'c',
      name: 'C',
      items: [
        {
          id: 'f',
          name: 'Folder',
          type: 'folder',
          items: [{ id: 'i1', name: 'MCP', type: 'request', request: mcpRequest() }],
        },
        {
          id: 'i2',
          name: 'Http',
          type: 'request',
          request: {
            id: 'r2',
            name: 'Http',
            type: 'http',
            method: 'GET',
            url: 'https://api.example.com',
            headers: [],
            params: [],
            body: { type: 'none' },
            auth: { type: 'bearer', bearer: { token: 'http-token' } },
          },
        },
      ],
    } as Collection;
    const out = redactMcpCollectionCredentials(collection);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain('http-token');
    expect(JSON.stringify(collection)).toContain(TOKEN);
  });
});

describe('collection export redaction covers MCP headers + auth', () => {
  it('a redacted OpenCollection export carries no MCP credential, even from the _oc bag', () => {
    const imported = ocToInternal(ocWithMcpCredentials() as never);
    const exported = JSON.stringify(internalToOC(redactCollectionSecrets(imported)));
    expect(exported).not.toContain(TOKEN);
    expect(exported).not.toContain(API_KEY);
    expect(exported).toContain('X-Tenant');
    expect(exported).toContain('acme');
  });

  it('a redacted export of an app-authored MCP request carries no credential', () => {
    const collection: Collection = {
      id: 'c',
      name: 'C',
      items: [{ id: 'i1', name: 'MCP', type: 'request', request: mcpRequest() }],
    } as Collection;
    const exported = JSON.stringify(internalToOC(redactCollectionSecrets(collection)));
    expect(exported).not.toContain(TOKEN);
    expect(exported).not.toContain(API_KEY);
  });
});
