// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

import { parseMcpConfigText } from '@shared/mcp-import/mcp-config-parser';
import { commitEntries, scanSourceFiles } from '../../electron/main/handlers/mcp-import-handler';
import { materializeMcpConnectAuth } from '../../electron/main/security/mcp-connect-auth';
import {
  __setSecretStoreForTests,
  type SecretStoreShape,
} from '../../electron/main/security/secret-handle-store';
import { draftToMcpRequest } from '../../src/features/mcp/lib/mcpImport';

type SecretData = Record<string, { value: string; label?: string; createdAt: number }>;
function memoryStore(): SecretStoreShape & { data: SecretData } {
  const data: SecretData = {};
  return {
    data,
    get: (k: string) => data[k],
    set: (k: string, v: SecretData[string]) => {
      data[k] = v;
    },
    delete: (k: string) => {
      delete data[k];
    },
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    has: (k: string) => k in data,
    get store() {
      return data;
    },
  };
}

const BEARER = 'sk-bearer-PLAINTEXT-123';
const APIKEY = 'apikey-PLAINTEXT-456';
const EXTRA = 'extra-PLAINTEXT-789';

function entriesFor(server: Record<string, unknown>) {
  const cfg = parseMcpConfigText(JSON.stringify({ mcpServers: { srv: server } }));
  return new Map(cfg.entries.map((e) => [`0.${e.key}`, e]));
}

let store: ReturnType<typeof memoryStore>;
beforeEach(() => {
  store = memoryStore();
  __setSecretStoreForTests(store);
});
afterAll(() => __setSecretStoreForTests(null));

describe('MCP import: HTTP header secrets never reach the renderer', () => {
  it('converts Authorization to a bearer handle, keeps non-secret headers plain, and connects', async () => {
    const entries = entriesFor({
      url: 'https://x.test/mcp',
      headers: { Authorization: `Bearer ${BEARER}`, 'X-Tenant': 'acme' },
    });
    const res = commitEntries(entries, ['0.0']);
    const draft = res.drafts[0];
    expect(JSON.stringify(res)).not.toContain(BEARER);
    expect(draft?.headers.map((h) => h.key)).toEqual(['X-Tenant']);
    expect(draft?.headers[0]).toMatchObject({ value: 'acme' });
    expect(draft?.auth).toMatchObject({ type: 'bearer', bearer: { token: { kind: 'handle' } } });
    expect(Object.values(store.data).map((d) => d.value)).toEqual([BEARER]);

    const req = draftToMcpRequest(draft as NonNullable<typeof draft>);
    expect(JSON.stringify(req)).not.toContain(BEARER);
    const out = await materializeMcpConnectAuth({
      url: req.url,
      headers: Object.fromEntries(req.headers.map((h) => [h.key, h.value])),
      auth: req.auth as never,
    });
    expect(out.headers.Authorization).toBe(`Bearer ${BEARER}`);
    expect(out.headers['X-Tenant']).toBe('acme');
  });

  it('maps a credential-named custom header to a handle-backed api-key', async () => {
    const entries = entriesFor({ url: 'https://x.test/mcp', headers: { 'X-API-Key': APIKEY } });
    const res = commitEntries(entries, ['0.0']);
    const draft = res.drafts[0];
    expect(JSON.stringify(res)).not.toContain(APIKEY);
    expect(draft?.headers).toEqual([]);
    expect(draft?.auth).toMatchObject({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', in: 'header', value: { kind: 'handle' } },
    });
    const req = draftToMcpRequest(draft as NonNullable<typeof draft>);
    const out = await materializeMcpConnectAuth({ url: req.url, auth: req.auth as never });
    expect(out.headers['X-API-Key']).toBe(APIKEY);
  });

  it('skips a header the MCP transport refuses when choosing the credential', () => {
    const entries = entriesFor({
      url: 'https://x.test/mcp',
      headers: { Cookie: 'session=abc', 'X-API-Key': APIKEY },
    });
    const res = commitEntries(entries, ['0.0']);
    expect(res.drafts[0]?.auth).toMatchObject({
      type: 'api-key',
      apiKey: { key: 'X-API-Key', value: { kind: 'handle' } },
    });
    expect(JSON.stringify(res)).not.toContain(APIKEY);
    expect(JSON.stringify(res)).not.toContain('session=abc');
  });

  it('never leaves a further secret header in plaintext when auth is already taken', () => {
    const entries = entriesFor({
      url: 'https://x.test/mcp',
      headers: { Authorization: `Bearer ${BEARER}`, 'X-Extra-Token': EXTRA },
    });
    const res = commitEntries(entries, ['0.0']);
    expect(JSON.stringify(res)).not.toContain(EXTRA);
    expect(JSON.stringify(res)).not.toContain(BEARER);
    expect(res.drafts[0]?.warnings.join(' ')).toMatch(/X-Extra-Token/);
  });

  it('scan preview carries no header plaintext', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-sec-'));
    try {
      const file = path.join(dir, 'c.json');
      writeFileSync(
        file,
        JSON.stringify({
          mcpServers: {
            web: {
              url: 'https://x.test',
              headers: { Authorization: `Bearer ${BEARER}`, 'X-Tenant': 'acme' },
            },
          },
        })
      );
      const { sources } = await scanSourceFiles([{ label: 'c', file, optional: false }], dir);
      expect(JSON.stringify(sources)).not.toContain(BEARER);
      expect(JSON.stringify(sources)).toContain('acme');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back created handles when the batch fails', () => {
    const entries = entriesFor({
      url: 'https://x.test/mcp',
      headers: { Authorization: `Bearer ${BEARER}` },
    });
    const bad = new Map(entries);
    bad.set('0.1', {
      get kind(): never {
        throw new Error('boom');
      },
    } as never);
    expect(() => commitEntries(bad, ['0.0', '0.1'])).toThrow('boom');
    expect(Object.keys(store.data)).toEqual([]);
  });
});
