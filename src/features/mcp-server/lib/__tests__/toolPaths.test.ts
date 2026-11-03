/**
 * Edge and refusal paths of the edit, environment and execute tools, run
 * through the real runtime and stores: what an agent is refused, what each
 * card says, and that undo refuses once its target moved on. The happy paths
 * live in runtime.test.ts.
 */

import {
  type McpServerConsent,
  setCollectionConsent,
  setEnvironmentConsent,
  setEnvironmentExecutable,
} from '@shared/mcp-server/consent';
import type { ControlToolResult, ToolCallEvent } from '@shared/mcp-server/control-bridge';
import { DEFAULT_MCP_SERVER_SETTINGS, type McpServerSettings } from '@shared/mcp-server/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { Collection, Environment } from '@/types';
import {
  settleApproval,
  settleSecretPrompt,
  useMcpServerRuntimeStore,
} from '../../store/useMcpServerRuntimeStore';

const runner = vi.hoisted(() => ({ runCollection: vi.fn() }));
vi.mock('@/features/collections/lib/collectionRunner', () => ({
  runCollection: runner.runCollection,
}));

import { runControlTool, undoActivity } from '../runtime';

const http = (id: string, url: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: 'request' as const,
  request: {
    id: `r-${id}`,
    name: id,
    type: 'http' as const,
    method: 'GET' as const,
    url,
    headers: [],
    params: [],
    body: { type: 'none' as const },
    auth: { type: 'none' as const },
    ...extra,
  },
});

const API: Collection = {
  id: 'col-api',
  name: 'API',
  items: [
    {
      id: 'fld-a',
      name: 'A',
      type: 'folder',
      items: [
        { id: 'fld-a1', name: 'A1', type: 'folder', items: [http('req-deep', 'https://a.test/x')] },
        http('req-a', 'https://a.test/a'),
      ],
    },
    http('req-root', 'https://b.test/root'),
  ],
};

const BROKER: Collection = {
  id: 'col-broker',
  name: 'Broker',
  items: [
    {
      id: 'req-kafka',
      name: 'kafka',
      type: 'request',
      request: {
        id: 'r-kafka',
        name: 'kafka',
        type: 'kafka',
        brokers: ['localhost:9092'],
      } as never,
    },
  ],
};

const DEV: Environment = {
  id: 'env-dev',
  name: 'dev',
  variables: [
    { id: 'v1', key: 'host', value: 'https://dev.test', enabled: true },
    { id: 'v2', key: 'token', value: 'tok', enabled: true, secret: true },
    {
      id: 'v3',
      key: 'vault',
      value: '',
      enabled: true,
      secretRef: { kind: 'handle', id: 'h1', label: 'k' },
    } as never,
  ],
};

const PROD: Environment = { id: 'env-prod', name: 'prod', variables: [] };

let seq = 0;
const call = (tool: string, input: unknown = {}): ToolCallEvent => ({
  callId: `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`,
  tool,
  input,
  client: { name: 'codex' },
});

function setSettings(patch: Partial<McpServerSettings>) {
  const current = useSettingsStore.getState().settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS;
  useSettingsStore.getState().updateSettings({ mcpServer: { ...current, ...patch } });
}
function grant(update: (c: McpServerConsent) => McpServerConsent) {
  const current = useSettingsStore.getState().settings.mcpServer ?? DEFAULT_MCP_SERVER_SETTINGS;
  setSettings({ consent: update(current.consent) });
}

async function answer(decision: 'approved' | 'denied') {
  await vi.waitFor(() =>
    expect(useMcpServerRuntimeStore.getState().approvals.length).toBeGreaterThan(0)
  );
  const card = useMcpServerRuntimeStore.getState().approvals[0]!;
  settleApproval(card.callId, decision);
  return card;
}

const error = (r: ControlToolResult) => (r.ok ? '' : r.error);
const data = <T>(r: ControlToolResult): T => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.data as T;
};
const latestActivity = () => useMcpServerRuntimeStore.getState().activity[0]!;
const run = (tool: string, input: unknown) => runControlTool(call(tool, input));

beforeEach(() => {
  useCollectionStore.setState({ collections: structuredClone([API, BROKER]) });
  useEnvironmentStore.setState({
    environments: structuredClone([DEV, PROD]),
    activeEnvironmentId: null,
  });
  useMcpServerRuntimeStore.setState({ approvals: [], secretPrompts: [], activity: [] });
  useSettingsStore.getState().updateSettings({
    mcpServer: {
      ...DEFAULT_MCP_SERVER_SETTINGS,
      enabled: true,
      approvalMode: 'auto-approve-edits',
    },
  });
  grant((c) => setCollectionConsent(setCollectionConsent(c, API.id, 'edit'), BROKER.id, 'edit'));
  runner.runCollection.mockReset();
});

describe('collection edits: refusals', () => {
  it('hidden collections and items read as not shared', async () => {
    grant((c) => setCollectionConsent(c, API.id, 'hidden'));
    expect(error(await run('create_folder', { collectionId: API.id, name: 'f' }))).toMatch(
      /not shared for editing/
    );
    expect(error(await run('rename_item', { itemId: 'req-a', name: 'x' }))).toMatch(
      /not shared for editing/
    );
    expect(error(await run('delete_collection', { collectionId: 'nope' }))).toMatch(
      /not shared for editing/
    );
  });

  it('a parent that is not a folder in this collection is refused', async () => {
    for (const parentFolderId of ['req-a', 'missing']) {
      expect(
        error(await run('create_folder', { collectionId: API.id, name: 'f', parentFolderId }))
      ).toMatch(/Folder not found in this collection/);
      expect(
        error(
          await run('create_request', {
            collectionId: API.id,
            parentFolderId,
            request: { type: 'http', name: 'n', url: 'https://x.test' },
          })
        )
      ).toMatch(/Folder not found/);
    }
  });

  it('create_request refuses a copied placeholder', async () => {
    expect(
      error(
        await run('create_request', {
          collectionId: API.id,
          request: { type: 'http', name: 'n', url: 'https://x.test/(redacted)' },
        })
      )
    ).toMatch(/redaction placeholder/);
  });

  it('update_request refuses folders and connection presets', async () => {
    expect(
      error(await run('update_request', { requestId: 'fld-a', patch: { name: 'x' } }))
    ).toMatch(/is a folder/);
    expect(
      error(await run('update_request', { requestId: 'req-kafka', patch: { name: 'x' } }))
    ).toMatch(/Connection presets/);
  });

  it('a folder cannot move into itself or its own subfolder', async () => {
    for (const targetFolderId of ['fld-a', 'fld-a1']) {
      expect(error(await run('move_item', { itemId: 'fld-a', targetFolderId }))).toMatch(
        /into itself/
      );
    }
    expect(error(await run('move_item', { itemId: 'req-a', targetFolderId: 'req-root' }))).toMatch(
      /Folder not found/
    );
  });

  it('Kafka/MQTT presets are never deleted by an agent', async () => {
    expect(error(await run('delete_item', { itemId: 'req-kafka' }))).toMatch(/Kafka\/MQTT/);
    expect(error(await run('delete_collection', { collectionId: BROKER.id }))).toMatch(
      /Kafka\/MQTT/
    );
  });
});

describe('collection edits: cards and undo', () => {
  it('update cards show each changed field, including a removed script', async () => {
    const pending = run('update_request', {
      requestId: 'req-a',
      patch: {
        preRequestScript: '',
        testScript: 'rs.test("t", () => {})',
        url: 'https://a.test/b',
      },
    });
    const card = await answer('denied');
    const text = card.details.join('\n');
    expect(text).toContain('New pre-request script: (removed)');
    expect(text).toContain('rs.test("t", () => {})');
    expect(text).toContain('url → https://a.test/b');
    expect((await pending).ok).toBe(false);
  });

  it('rename a folder, move to root and into a folder, each undoable', async () => {
    data(await run('rename_item', { itemId: 'fld-a1', name: 'Deep' }));
    data(await run('move_item', { itemId: 'req-deep' }));
    data(await run('move_item', { itemId: 'req-root', targetFolderId: 'fld-a' }));
    const cols = useCollectionStore.getState();
    const api = cols.getCollectionById(API.id)!;
    expect(api.items.map((i) => i.id)).toContain('req-deep');
    expect(api.items.map((i) => i.id)).not.toContain('req-root');
    // Undo the last move only: it is still exactly as the agent left it.
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(
      useCollectionStore
        .getState()
        .getCollectionById(API.id)!
        .items.map((i) => i.id)
    ).toContain('req-root');
  });

  it('undo refuses once the collection changed after the agent’s change', async () => {
    data(
      await run('create_folder', { collectionId: API.id, name: 'New', parentFolderId: 'fld-a' })
    );
    const created = latestActivity();
    data(await run('rename_item', { itemId: 'req-root', name: 'Renamed' }));
    const undo = await undoActivity(created.id);
    expect(undo.ok).toBe(false);
    expect(!undo.ok && undo.error).toMatch(/changed after this/);
  });

  it('delete_item on a folder counts its requests and undo restores it', async () => {
    const pending = run('delete_item', { itemId: 'fld-a' });
    const card = await answer('approved');
    expect(card.details).toContain('Includes 2 request(s)');
    data(await pending);
    expect(useCollectionStore.getState().getCollectionById(API.id)!.items).toHaveLength(1);
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(useCollectionStore.getState().getCollectionById(API.id)!.items).toHaveLength(2);
  });

  it('delete_collection then undo brings it back; a collection created by the agent undoes away', async () => {
    const pending = run('delete_collection', { collectionId: API.id });
    const card = await answer('approved');
    expect(card.details[0]).toBe('3 request(s) will be removed');
    data(await pending);
    expect(useCollectionStore.getState().getCollectionById(API.id)).toBeUndefined();
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(useCollectionStore.getState().getCollectionById(API.id)).toBeDefined();

    const { collectionId } = data<{ collectionId: string }>(
      await run('create_collection', { name: 'Scratch', description: 'tmp' })
    );
    expect(useCollectionStore.getState().getCollectionById(collectionId)?.description).toBe('tmp');
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(useCollectionStore.getState().getCollectionById(collectionId)).toBeUndefined();
  });
});

describe('import_collection', () => {
  it('is refused without any edit grant', async () => {
    setSettings({ consent: DEFAULT_MCP_SERVER_SETTINGS.consent });
    expect(error(await run('import_collection', { format: 'curl', content: 'curl x' }))).toMatch(
      /Importing is not allowed/
    );
  });

  it('reports a document that does not parse', async () => {
    expect(
      error(await run('import_collection', { format: 'postman', content: '{not json' }))
    ).toMatch(/postman document is not valid JSON/);
    expect(
      error(await run('import_collection', { format: 'openapi', content: 'a: [unclosed' }))
    ).toMatch(/Could not parse the openapi document/);
  });

  it('imports OpenAPI YAML under a chosen name, and undo removes it', async () => {
    const yaml = [
      'openapi: 3.0.0',
      'info: { title: Pets, version: "1" }',
      'servers: [{ url: "https://pets.test" }]',
      'paths:',
      '  /pets:',
      '    get: { summary: List pets, responses: { "200": { description: ok } } }',
    ].join('\n');
    const result = data<{ collectionId: string; name: string; requestCount: number }>(
      await run('import_collection', { format: 'openapi', content: yaml, name: 'Petstore' })
    );
    expect(result).toMatchObject({ name: 'Petstore', requestCount: 1 });
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(useCollectionStore.getState().getCollectionById(result.collectionId)).toBeUndefined();
  });

  it('a Postman document with a script always asks and shows it', async () => {
    const doc = {
      info: { name: 'PM', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/' },
      item: [
        {
          name: 'one',
          request: { method: 'GET', url: 'https://pm.test/' },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
        },
      ],
    };
    const pending = run('import_collection', { format: 'postman', content: JSON.stringify(doc) });
    const card = await answer('denied');
    expect(card.details.join('\n')).toMatch(/one.*test script/s);
    expect((await pending).ok).toBe(false);
  });
});

describe('environment tools', () => {
  beforeEach(() => {
    grant((c) => setEnvironmentConsent(setEnvironmentConsent(c, DEV.id, 'edit'), PROD.id, 'edit'));
  });

  it('create_environment refuses placeholders and needs an environment grant', async () => {
    expect(
      error(
        await run('create_environment', {
          name: 'x',
          variables: [{ key: 'k', value: '(secret)' }],
        })
      )
    ).toMatch(/redaction placeholder/);
    setSettings({ consent: DEFAULT_MCP_SERVER_SETTINGS.consent });
    expect(error(await run('create_environment', { name: 'x' }))).toMatch(
      /Creating environments is not allowed/
    );
  });

  it('create_environment with variables, then undo removes it', async () => {
    const { environmentId } = data<{ environmentId: string }>(
      await run('create_environment', { name: 'qa', variables: [{ key: 'host', value: 'h' }] })
    );
    expect(
      useEnvironmentStore.getState().environments.find((e) => e.id === environmentId)?.variables
    ).toHaveLength(1);
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(
      useEnvironmentStore.getState().environments.find((e) => e.id === environmentId)
    ).toBeUndefined();
  });

  it('set_environment_variable: refusals, update with enabled flag, and add', async () => {
    const base = { environmentId: DEV.id };
    expect(
      error(await run('set_environment_variable', { ...base, key: 'k', value: '(secret)' }))
    ).toMatch(/placeholder/);
    expect(
      error(await run('set_environment_variable', { ...base, key: 'token', value: 'x' }))
    ).toMatch(/is a secret variable/);
    data(
      await run('set_environment_variable', { ...base, key: 'host', value: 'h2', enabled: false })
    );
    data(
      await run('set_environment_variable', { ...base, key: 'extra', value: 'e', enabled: false })
    );
    const vars = useEnvironmentStore
      .getState()
      .environments.find((e) => e.id === DEV.id)!.variables;
    expect(vars.find((v) => v.key === 'host')).toMatchObject({ value: 'h2', enabled: false });
    expect(vars.find((v) => v.key === 'extra')).toMatchObject({ value: 'e', enabled: false });
  });

  it('request_secret_variable updates an existing variable as secret; keychain vars are refused', async () => {
    expect(
      error(
        await run('request_secret_variable', { environmentId: DEV.id, key: 'vault', reason: 'r' })
      )
    ).toMatch(/desktop keychain/);
    const pending = run('request_secret_variable', {
      environmentId: DEV.id,
      key: 'host',
      reason: 'needed',
    });
    await vi.waitFor(() =>
      expect(useMcpServerRuntimeStore.getState().secretPrompts.length).toBe(1)
    );
    settleSecretPrompt(useMcpServerRuntimeStore.getState().secretPrompts[0]!.callId, 'typed');
    const result = data<{ set: boolean; reference: string }>(await pending);
    expect(result).toEqual(expect.objectContaining({ set: true, reference: '{{host}}' }));
    expect(JSON.stringify(result)).not.toContain('typed');
    const host = useEnvironmentStore
      .getState()
      .environments.find((e) => e.id === DEV.id)!
      .variables.find((v) => v.key === 'host');
    expect(host).toMatchObject({ value: 'typed', secret: true });
  });

  it('set_active_environment: switch, clear, undo, and refusals', async () => {
    expect(error(await run('set_active_environment', { environmentId: 'nope' }))).toMatch(
      /not found or not shared/
    );
    data(await run('set_active_environment', { environmentId: DEV.id }));
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe(DEV.id);
    data(await run('set_active_environment', {}));
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBeNull();
    expect(await undoActivity(latestActivity().id)).toEqual({ ok: true });
    expect(useEnvironmentStore.getState().activeEnvironmentId).toBe(DEV.id);

    // Undo of the first switch now conflicts: the active environment moved on.
    useEnvironmentStore.getState().setActiveEnvironment(PROD.id);
    const first = useMcpServerRuntimeStore.getState().activity.at(-1)!;
    expect((await undoActivity(first.id)).ok).toBe(false);

    // The user's active environment is not shared for editing: no switching away.
    grant((c) => setEnvironmentConsent(c, PROD.id, 'read-only'));
    expect(error(await run('set_active_environment', { environmentId: DEV.id }))).toMatch(
      /active environment is not shared/
    );
  });

  it('delete_environment_variable refuses a missing key', async () => {
    expect(
      error(await run('delete_environment_variable', { environmentId: DEV.id, key: 'nope' }))
    ).toMatch(/No variable “nope”/);
  });
});

describe('execute tools: refusals', () => {
  beforeEach(() => {
    grant((c) => setCollectionConsent(c, API.id, 'full'));
  });

  it('send_request refuses a folder and an environment it may not send with', async () => {
    expect(error(await run('send_request', { requestId: 'fld-a' }))).toMatch(/is a folder/);
    grant((c) => setEnvironmentConsent(c, DEV.id, 'read-only'));
    expect(
      error(await run('send_request', { requestId: 'req-a', environmentId: DEV.id }))
    ).toBeTruthy();
    grant((c) => setEnvironmentExecutable(c, DEV.id, true));
    const pending = run('send_request', { requestId: 'req-a', environmentId: DEV.id });
    const card = await answer('denied');
    expect(card.details).toContain('Environment “dev”');
    expect((await pending).ok).toBe(false);
  });

  it('run_collection refuses a folder that is not in the collection, and edit-only access', async () => {
    expect(error(await run('run_collection', { collectionId: API.id, folderId: 'req-a' }))).toMatch(
      /Folder not found/
    );
    grant((c) => setCollectionConsent(c, API.id, 'edit'));
    expect(error(await run('run_collection', { collectionId: API.id }))).toBeTruthy();
  });

  it('a folder run card lists the folder’s destinations and caps a long list', async () => {
    const many = Array.from({ length: 12 }, (_, i) => http(`m${i}`, `https://h${i}.test/p`));
    useCollectionStore.getState().updateCollection(API.id, {
      items: [...useCollectionStore.getState().getCollectionById(API.id)!.items, ...many],
    });
    const pending = run('run_collection', {
      collectionId: API.id,
      folderId: 'fld-a',
      iterations: 2,
      stopOnFailure: true,
    });
    const folderCard = await answer('denied');
    expect(folderCard.title).toMatch(/Run folder/);
    expect(folderCard.details).toEqual(
      expect.arrayContaining([
        '2 request(s) × 2 iteration(s)',
        'Sends to: GET https://a.test',
        'Stops at the first failure',
      ])
    );
    await pending;

    const all = run('run_collection', { collectionId: API.id });
    const card = await answer('denied');
    expect(card.details.filter((d) => d.startsWith('Sends to:'))).toHaveLength(9);
    expect(card.details).toContain('Sends to: +6 more destination(s)');
    await all;
  });
});
