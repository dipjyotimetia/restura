/**
 * @vitest-environment jsdom
 *
 * Security regressions for the MCP control server (ADR 0041) — the agent is
 * an untrusted consumer of the user's workspace:
 *
 *  1. Exfiltration: with EVERYTHING shared read-only, no read tool returns a
 *     secret — plaintext auth, credential headers/params, URL userinfo,
 *     secret-flagged environment variables, SecretRef handle ids, body
 *     passwords.
 *  2. Self-escalation: no tool module can write MCP settings except the
 *     narrow "grant edit on what you just created" path.
 *  3. Secrets never flow in through tool arguments: every credential field in
 *     every auth an agent can author only accepts a {{variable}} reference.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolCallEvent } from '@shared/mcp-server/control-bridge';
import { AuthInputSchema, NewRequestInputSchema } from '@shared/mcp-server/control-tools';
import { DEFAULT_MCP_SERVER_SETTINGS } from '@shared/mcp-server/settings';
import { beforeEach, describe, expect, it } from 'vitest';
import { runControlTool } from '@/features/mcp-server/lib/runtime';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Collection, Environment, HistoryItem } from '@/types';

const SECRETS = [
  'sk-live-PLAINTEXT-BEARER',
  'basic-PASSWORD-123',
  'apikey-VALUE-456',
  'header-AUTH-789',
  'query-TOKEN-abc',
  'url-userinfo-PASS',
  'env-SECRET-value',
  'body-PASSWORD-xyz',
  'grpc-meta-TOKEN',
  'handle-id-SHOULD-NOT-LEAK',
  'oauth-REFRESH-tok',
  'history-url-PASS',
  'gql-vars-PASSWORD',
  'mcp-params-TOKEN',
  'form-body-PASSWORD',
];

const COLLECTION: Collection = {
  id: 'c1',
  name: 'Everything',
  auth: { type: 'bearer', bearer: { token: 'sk-live-PLAINTEXT-BEARER' } },
  items: [
    {
      id: 'i-basic',
      name: 'basic',
      type: 'request',
      request: {
        id: 'r1',
        name: 'basic',
        type: 'http',
        method: 'POST',
        url: 'https://admin:url-userinfo-PASS@api.example.com/x?access_token=query-TOKEN-abc',
        headers: [
          { id: 'h', key: 'Authorization', value: 'Bearer header-AUTH-789', enabled: true },
          { id: 'h2', key: 'X-Session-Token', value: 'header-AUTH-789', enabled: true },
        ],
        params: [{ id: 'p', key: 'api_key', value: 'query-TOKEN-abc', enabled: true }],
        body: { type: 'json', raw: JSON.stringify({ user: 'a', password: 'body-PASSWORD-xyz' }) },
        auth: { type: 'basic', basic: { username: 'u', password: 'basic-PASSWORD-123' } },
      },
    },
    {
      id: 'i-apikey',
      name: 'apikey',
      type: 'request',
      request: {
        id: 'r2',
        name: 'apikey',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: {
          type: 'api-key',
          apiKey: {
            key: 'X-Key',
            value: { kind: 'handle', id: 'handle-id-SHOULD-NOT-LEAK', label: 'Prod key' },
            in: 'header',
          },
        },
      },
    },
    {
      id: 'i-oauth',
      name: 'oauth',
      type: 'request',
      request: {
        id: 'r3',
        name: 'oauth',
        type: 'http',
        method: 'GET',
        url: 'https://api.example.com',
        headers: [],
        params: [],
        body: { type: 'none' },
        auth: {
          type: 'oauth2',
          oauth2: { accessToken: 'apikey-VALUE-456', refreshToken: 'oauth-REFRESH-tok' },
        },
      },
    },
    {
      id: 'i-gql',
      name: 'gql',
      type: 'request',
      request: {
        id: 'r5',
        name: 'gql',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com/graphql',
        headers: [],
        params: [],
        body: {
          type: 'graphql',
          raw: 'mutation Login($password: String!) { login(password: $password) }',
          graphqlVariables: JSON.stringify({ password: 'gql-vars-PASSWORD' }),
        },
        auth: { type: 'none' },
      },
    },
    {
      id: 'i-form',
      name: 'form',
      type: 'request',
      request: {
        id: 'r6',
        name: 'form',
        type: 'http',
        method: 'POST',
        url: 'https://api.example.com/login',
        headers: [],
        params: [],
        body: { type: 'x-www-form-urlencoded', raw: 'user=ada&password=form-body-PASSWORD' },
        auth: { type: 'none' },
      },
    },
    {
      id: 'i-mcp',
      name: 'mcp',
      type: 'request',
      request: {
        id: 'r7',
        name: 'mcp',
        type: 'mcp',
        url: 'https://mcp.example.com',
        transport: 'streamable-http',
        headers: [],
        auth: { type: 'none' },
        defaultMethod: 'tools/call',
        defaultParams: JSON.stringify({
          name: 'login',
          arguments: { apiToken: 'mcp-params-TOKEN' },
        }),
      },
    },
    {
      id: 'i-grpc',
      name: 'grpc',
      type: 'request',
      request: {
        id: 'r4',
        name: 'grpc',
        type: 'grpc',
        methodType: 'unary',
        url: 'grpc://h:1',
        service: 's',
        method: 'm',
        metadata: [{ id: 'm', key: 'authorization', value: 'grpc-meta-TOKEN', enabled: true }],
        message: '{}',
        auth: { type: 'none' },
      },
    },
  ],
};

const ENVIRONMENT: Environment = {
  id: 'e1',
  name: 'prod',
  variables: [
    { id: 'v1', key: 'apiToken', value: 'env-SECRET-value', enabled: true, secret: true },
    { id: 'v2', key: 'clientSecret', value: 'env-SECRET-value', enabled: true },
  ],
};

const HISTORY: HistoryItem[] = [
  {
    id: 'h1',
    timestamp: 1,
    request: {
      ...(COLLECTION.items[0]!.request as object),
      url: 'https://u:history-url-PASS@api.example.com/',
    } as HistoryItem['request'],
  },
];

let seq = 0;
const call = (tool: string, input: unknown): ToolCallEvent => ({
  callId: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  tool,
  input,
});

beforeEach(() => {
  useCollectionStore.setState({ collections: structuredClone([COLLECTION]) });
  useEnvironmentStore.setState({
    environments: structuredClone([ENVIRONMENT]),
    activeEnvironmentId: null,
  });
  useHistoryStore.setState({ history: structuredClone(HISTORY) });
  useSettingsStore.getState().updateSettings({
    mcpServer: {
      ...DEFAULT_MCP_SERVER_SETTINGS,
      enabled: true,
      consent: {
        defaultLevel: 'read-only',
        perCollection: {},
        environmentsDefaultLevel: 'read-only',
        perEnvironment: {},
        executableEnvironments: {},
        historyLevel: 'read-only',
      },
    },
  });
});

describe('MCP control server: no read tool leaks a secret', () => {
  const READS: Array<[string, unknown]> = [
    ['describe_access', {}],
    ['list_collections', {}],
    ['get_collection_tree', { collectionId: 'c1' }],
    ['list_requests', { collectionId: 'c1' }],
    ['get_request', { requestId: 'i-basic' }],
    ['get_request', { requestId: 'i-apikey' }],
    ['get_request', { requestId: 'i-oauth' }],
    ['get_request', { requestId: 'i-grpc' }],
    ['get_request', { requestId: 'i-gql' }],
    ['get_request', { requestId: 'i-form' }],
    ['get_request', { requestId: 'i-mcp' }],
    ['list_environments', {}],
    ['get_environment', { id: 'e1' }],
    ['get_history', {}],
    ['list_collection_runs', { collectionId: 'c1' }],
  ];

  it.each(READS)('%s %j', async (tool, input) => {
    const result = await runControlTool(call(tool, input));
    expect(result.ok).toBe(true);
    const serialised = JSON.stringify(result);
    for (const secret of SECRETS) expect(serialised).not.toContain(secret);
  });
});

describe('MCP control server: masks never overwrite secrets', () => {
  it.each(['i-basic', 'i-gql', 'i-form', 'i-grpc', 'i-mcp'])(
    'get_request %s → update_request with every field copied back keeps every secret',
    async (requestId) => {
      useSettingsStore.getState().updateSettings({
        mcpServer: {
          ...DEFAULT_MCP_SERVER_SETTINGS,
          enabled: true,
          approvalMode: 'auto-approve-edits',
          consent: { ...DEFAULT_MCP_SERVER_SETTINGS.consent, defaultLevel: 'edit' },
        },
      });
      const before = JSON.stringify(useCollectionStore.getState().collections);
      const read = await runControlTool(call('get_request', { requestId }));
      if (!read.ok) throw new Error(read.error);
      const d = read.data as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of ['url', 'headers', 'params', 'metadata', 'message', 'defaultParams'])
        if (d[key] !== undefined) patch[key] = d[key];
      if (d.body) patch.body = d.body;
      const write = await runControlTool(call('update_request', { requestId, patch }));
      // Either the copy-back is accepted with real values kept, or refused.
      if (write.ok) {
        const after = JSON.stringify(useCollectionStore.getState().collections);
        for (const secret of SECRETS) {
          if (before.includes(secret)) expect(after, secret).toContain(secret);
        }
        expect(after).not.toMatch(/\(redacted\)|%28secret%29|\(secret\)/);
      }
    }
  );
});

describe('MCP control server: no self-escalation', () => {
  const TOOLS_DIR = path.resolve(__dirname, '../../src/features/mcp-server/lib/tools');

  it('tool modules never touch settings directly', () => {
    for (const file of readdirSync(TOOLS_DIR)) {
      const source = readFileSync(path.join(TOOLS_DIR, file), 'utf8');
      expect(source, file).not.toMatch(/useSettingsStore|updateMcpServerSettings|updateSettings\(/);
    }
  });

  it('the only consent writes grant edit on the id that was just created', () => {
    const source = readdirSync(TOOLS_DIR)
      .filter((file) => file.endsWith('.ts'))
      .map((file) => readFileSync(path.join(TOOLS_DIR, file), 'utf8'))
      .join('\n');
    const grants = source.match(/grant\(\(c\) => [^)]*\)/g) ?? [];
    expect(grants.sort()).toEqual(
      [
        "grant((c) => setCollectionConsent(c, collection.id, 'edit')",
        "grant((c) => setCollectionConsent(c, collection.id, 'edit')",
        "grant((c) => setEnvironmentConsent(c, environment.id, 'edit')",
      ].sort()
    );
    // updateMcpConsent is only reachable through `grant`.
    expect(source.match(/updateMcpConsent\(/g)).toHaveLength(1);
  });
});

describe('MCP control server: secrets never flow in through arguments', () => {
  it.each([
    { type: 'bearer', token: 'sk-live' },
    { type: 'basic', username: 'u', password: 'p' },
    { type: 'api-key', key: 'k', value: 'v' },
  ])('refuses plaintext credential %j', (auth) => {
    expect(AuthInputSchema.safeParse(auth).success).toBe(false);
    expect(
      NewRequestInputSchema.safeParse({ type: 'http', name: 'n', url: 'u', auth }).success
    ).toBe(false);
  });
});
