import { describe, expect, it } from 'vitest';
import { internalToOC } from '../../opencollection/from-internal';
import { ocToInternal } from '../../opencollection/to-internal';
import type { Collection, McpRequest } from '../../types';
import { countCollectionInlineSecrets, redactCollectionSecrets } from '../collection-redaction';
import {
  redactMcpCollectionCredentials,
  redactMcpCredentials,
  redactUrlCredentialsForStorage,
} from '../mcp-credential-redaction';

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
      {
        id: 'h1',
        key: 'Authorization',
        value: `Bearer ${TOKEN}`,
        enabled: true,
      },
      { id: 'h2', key: 'X-Tenant', value: 'acme', enabled: true },
      {
        id: 'h3',
        key: 'X-Custom',
        value: API_KEY,
        enabled: true,
        secret: true,
      },
    ],
    auth: {
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: TOKEN } },
    },
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
            auth: {
              type: 'apikey',
              key: 'X-API-Key',
              value: API_KEY,
              placement: 'header',
            },
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
    expect(out.auth).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'inline', value: '' } },
    });
  });

  it('preserves SecretRef handles (opaque ids, no plaintext)', () => {
    const out = redactMcpCredentials(
      mcpRequest({
        headers: [],
        auth: {
          type: 'bearer',
          bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } },
        },
      })
    );
    expect(out.auth).toEqual({
      type: 'bearer',
      bearer: { token: { kind: 'handle', id: 'h1', label: 'mcp' } },
    });
  });

  it('does not mutate the input and tolerates a connection without auth', () => {
    const input = {
      headers: [{ key: 'Authorization', value: 'Bearer x', enabled: true }],
    };
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

describe('redactMcpCollectionCredentials — legacy / sparse collections', () => {
  it('tolerates a collection or folder without items (and junk entries)', () => {
    const noItems = { id: 'c', name: 'Legacy' } as unknown as Collection;
    expect(redactMcpCollectionCredentials(noItems)).toEqual(noItems);

    const sparse = {
      id: 'c2',
      name: 'Sparse',
      items: [
        null,
        { id: 'f', name: 'Folder', type: 'folder' },
        { id: 'f2', name: 'Bad', type: 'folder', items: 'nope' },
        {
          id: 'f3',
          name: 'Nested',
          type: 'folder',
          items: [{ id: 'i', name: 'MCP', type: 'request', request: mcpRequest() }],
        },
      ],
    } as unknown as Collection;
    const out = redactMcpCollectionCredentials(sparse);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.items[0]).toBeNull();
    expect(out.items[1]).toEqual({ id: 'f', name: 'Folder', type: 'folder' });
    expect((out.items[2] as { items?: unknown }).items).toBe('nope');
  });
});

describe('redactUrlCredentialsForStorage (security review M1a)', () => {
  it.each([
    ['https://user:pa55@mcp.example.com/mcp', 'https://mcp.example.com/mcp'],
    ['https://tok@mcp.example.com/mcp?x=1', 'https://mcp.example.com/mcp?x=1'],
    [
      'https://mcp.example.com/mcp?api_key=K&tenant=acme&access_token=T#frag',
      'https://mcp.example.com/mcp?api_key=&tenant=acme&access_token=#frag',
    ],
    ['{{base}}/mcp?token=abc&page_token=p2', '{{base}}/mcp?token=&page_token=p2'],
    [
      'https://mcp.example.com/mcp?token={{mcpToken}}',
      'https://mcp.example.com/mcp?token={{mcpToken}}',
    ],
    ['https://mcp.example.com/mcp?flag&auth=', 'https://mcp.example.com/mcp?flag&auth='],
    ['https://mcp.example.com/mcp?%E0%A4%A=1', 'https://mcp.example.com/mcp?%E0%A4%A=1'],
    ['https://mcp.example.com/mcp', 'https://mcp.example.com/mcp'],
  ])('%s → %s', (input, expected) => {
    expect(redactUrlCredentialsForStorage(input)).toBe(expected);
  });

  it('redactMcpCredentials scrubs the URL and gateway-style X-Auth headers', () => {
    const out = redactMcpCredentials({
      url: `https://u:${TOKEN}@mcp.example.com/mcp?key=${API_KEY}`,
      headers: [
        { key: 'X-Auth', value: TOKEN, enabled: true },
        { key: 'X-MCP-Auth', value: TOKEN, enabled: true },
        { key: 'X-Gateway-Authz', value: TOKEN, enabled: true },
        { key: 'X-Author', value: 'alice', enabled: true },
      ],
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(API_KEY);
    expect(out.headers?.[3]?.value).toBe('alice');
  });

  it('scrubs URL credentials in cached root x-restura-mcp entries', () => {
    const oc = ocWithMcpCredentials();
    const entry = oc.extensions['x-restura-mcp'][0] as { mcp: { url: string } };
    entry.mcp.url = `https://mcp.example.com/mcp?api_key=${API_KEY}`;
    const out = redactMcpCollectionCredentials(ocToInternal(oc as never));
    expect(JSON.stringify(out)).not.toContain(API_KEY);
  });
});

describe('opaque (non-MCP) _oc bag rows — export redaction + warning count (L2/L3)', () => {
  const wsCollection = (): Collection =>
    ({
      id: 'c',
      name: 'C',
      items: [
        {
          id: 'ws',
          name: 'Live (WebSocket)',
          type: 'folder',
          items: [],
          _oc: {
            info: { type: 'websocket', name: 'Live' },
            websocket: {
              url: 'wss://ws.example.com',
              headers: [
                { name: 'Authorization', value: '{{wsToken}}' },
                { name: 'X-Auth', value: 'ws-plaintext-secret' },
                { name: 'X-Tenant', value: 'acme' },
              ],
            },
          },
        },
      ],
    }) as unknown as Collection;

  it('blanks plaintext credential rows but keeps single {{var}} references', () => {
    const out = JSON.stringify(redactCollectionSecrets(wsCollection()));
    expect(out).not.toContain('ws-plaintext-secret');
    expect(out).toContain('{{wsToken}}');
    expect(out).toContain('acme');
  });

  it('counts bag-only plaintext credential rows so the export warning fires', () => {
    expect(countCollectionInlineSecrets(wsCollection())).toBe(1);
  });

  it('does not double-count rows of a modelled (MCP) bag already counted on the typed request', () => {
    const imported = ocToInternal(ocWithMcpCredentials() as never);
    // Typed: the Authorization header + the api-key value; root bag rows aren't re-counted.
    expect(countCollectionInlineSecrets(imported)).toBe(2);
  });
});

describe('review follow-ups', () => {
  it('strips userinfo up to the last @ in the authority', () => {
    expect(redactUrlCredentialsForStorage('https://user:p@ss@mcp.example.com/mcp')).toBe(
      'https://mcp.example.com/mcp'
    );
  });

  it('keeps single {{var}} references in headers and inline auth but blanks real secrets', () => {
    const out = redactMcpCredentials(
      mcpRequest({
        headers: [
          {
            id: 'h1',
            key: 'Authorization',
            value: '{{mcpToken}}',
            enabled: true,
          },
          { id: 'h2', key: 'X-Api-Key', value: API_KEY, enabled: true },
        ],
        auth: { type: 'bearer', bearer: { token: '{{mcpToken}}' } },
      })
    );
    expect(out.headers?.[0]?.value).toBe('{{mcpToken}}');
    expect(out.headers?.[1]?.value).not.toContain(API_KEY);
    expect(out.auth?.bearer?.token).toBe('{{mcpToken}}');
    const leaked = redactMcpCredentials(mcpRequest());
    expect(JSON.stringify(leaked)).not.toContain(TOKEN);
  });
});
