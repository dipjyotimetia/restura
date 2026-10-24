// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHandle = vi.hoisted(() => vi.fn());
const mockShowOpenDialog = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: { handle: mockHandle, removeHandler: vi.fn() },
  dialog: { showOpenDialog: mockShowOpenDialog },
}));

import { parseMcpConfigText } from '@shared/mcp-import/mcp-config-parser';
import {
  __mcpImportSessionCountForTests,
  __seedMcpImportSessionForTests,
  buildStdioDraft,
  commitEntries,
  envIsHandleBacked,
  importHandleLabel,
  registerMcpImportIPC,
  scanSourceFiles,
  unregisterMcpImportIPC,
} from '../handlers/mcp-import-handler';
import { displayPath, knownMcpConfigSources } from '../handlers/mcp-import-paths';
import { __setSecretStoreForTests, type SecretStoreShape } from '../security/secret-handle-store';

type Handler = (event: unknown, payload?: unknown) => Promise<unknown>;

type SecretData = Record<string, { value: string; label?: string; createdAt: number }>;

function memorySecretStore(): SecretStoreShape & { data: SecretData } {
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

const ABS = path.resolve('/tmp');
const stdioCfg = (server: Record<string, unknown>) =>
  parseMcpConfigText(JSON.stringify({ mcpServers: { srv: server } })).entries;

let secrets: ReturnType<typeof memorySecretStore>;
beforeEach(() => {
  secrets = memorySecretStore();
  __setSecretStoreForTests(secrets);
});
afterAll(() => __setSecretStoreForTests(null));

describe('known paths', () => {
  it('derives fixed per-OS locations from the home dir only', () => {
    const mac = knownMcpConfigSources('darwin', '/Users/me', undefined).map((s) => s.file);
    expect(mac).toEqual([
      '/Users/me/Library/Application Support/Claude/claude_desktop_config.json',
      '/Users/me/.cursor/mcp.json',
      '/Users/me/Library/Application Support/Code/User/mcp.json',
      '/Users/me/Library/Application Support/Code/User/settings.json',
    ]);
    const win = knownMcpConfigSources('win32', 'C:\\Users\\me', 'C:\\Users\\me\\AppData\\Roaming');
    expect(win[0]?.file).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json'
    );
    expect(knownMcpConfigSources('linux', '/home/me', undefined)[0]?.file).toBe(
      '/home/me/.config/Claude/claude_desktop_config.json'
    );
    expect(displayPath('/Users/me/.cursor/mcp.json', '/Users/me')).toBe('~/.cursor/mcp.json');
  });
});

describe('envIsHandleBacked / labels', () => {
  it('hides only credential-named, non-execution-sensitive, non-placeholder values', () => {
    expect(envIsHandleBacked({ name: 'API_KEY', value: 'x' })).toBe(true);
    expect(envIsHandleBacked({ name: 'LOG_LEVEL', value: 'x' })).toBe(false);
    expect(envIsHandleBacked({ name: 'API_KEY', value: '' })).toBe(false);
    expect(envIsHandleBacked({ name: 'API_KEY', value: '{{KEY}}' })).toBe(false);
    expect(envIsHandleBacked({ name: 'NPM_CONFIG_TOKEN', value: 'x' })).toBe(false);
    expect(envIsHandleBacked({ name: 'GIT_ASKPASS_TOKEN', value: 'x' })).toBe(false);
  });

  it('derives labels from server + var name and strips control characters', () => {
    const label = importHandleLabel('my\u202eserver\u2028', 'API\u200b_KEY');
    expect(label).toBe('MCP import: myserver API__KEY');
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label)).toBe(false);
    expect(importHandleLabel('\u200b', '')).toBe('Imported MCP secret');
  });
});

describe('buildStdioDraft / commitEntries', () => {
  it('stores secret env values as handles; plain values and sensitive names stay plain', () => {
    const [entry] = stdioCfg({
      command: 'npx',
      args: ['-y', 'srv'],
      env: {
        GITHUB_TOKEN: 'ghp_plaintext_secret',
        LOG_LEVEL: 'debug',
        NODE_OPTIONS: '--require x',
        REF_TOKEN: '{{MY_TOKEN}}',
      },
    });
    if (entry?.kind !== 'stdio') throw new Error('expected stdio');
    const built = buildStdioDraft(entry);
    if (!('draft' in built)) throw new Error(built.reason);
    const env = built.draft.stdio?.env ?? [];
    const gh = env.find((e) => e.key === 'GITHUB_TOKEN');
    expect(gh).toMatchObject({ value: '', secret: true, secretRef: { kind: 'handle' } });
    expect(gh?.secretRef?.label).toBe('MCP import: srv GITHUB_TOKEN');
    expect(env.find((e) => e.key === 'LOG_LEVEL')?.value).toBe('debug');
    expect(env.find((e) => e.key === 'NODE_OPTIONS')?.value).toBe('--require x');
    expect(env.find((e) => e.key === 'REF_TOKEN')).toEqual({
      key: 'REF_TOKEN',
      value: '{{MY_TOKEN}}',
    });
    // Plaintext lives only in the main-side store, never in the draft.
    expect(JSON.stringify(built.draft)).not.toContain('ghp_plaintext_secret');
    const stored = Object.values(secrets.data);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe('ghp_plaintext_secret');
    expect(gh?.secretRef && secrets.data[gh.secretRef.id]).toBeDefined();
  });

  it('skips an invalid entry without leaving any handle behind', () => {
    const [entry] = stdioCfg({
      command: 'np\u202ex',
      env: { API_KEY: 'topsecret' },
    });
    if (entry?.kind !== 'stdio') throw new Error('expected stdio');
    expect('reason' in buildStdioDraft(entry)).toBe(true);
    expect(Object.keys(secrets.data)).toHaveLength(0);
  });

  it('rejects a handle-eligible-looking name that is not a valid env name', () => {
    const [entry] = stdioCfg({ command: 'x', env: { 'BAD-TOKEN': 'v' } });
    if (entry?.kind !== 'stdio') throw new Error('expected stdio');
    expect('reason' in buildStdioDraft(entry)).toBe(true);
    expect(Object.keys(secrets.data)).toHaveLength(0);
  });

  it('keeps an absolute cwd and drops a non-absolute one with a warning', () => {
    const [a] = stdioCfg({ command: 'x', cwd: ABS });
    const [b] = stdioCfg({ command: 'x', cwd: '${workspaceFolder}' });
    if (a?.kind !== 'stdio' || b?.kind !== 'stdio') throw new Error('expected stdio');
    const da = buildStdioDraft(a);
    const db = buildStdioDraft(b);
    expect('draft' in da && da.draft.stdio?.cwd).toBe(ABS);
    expect('draft' in db && db.draft.stdio?.cwd).toBeUndefined();
    expect('draft' in db && db.draft.warnings.join()).toMatch(/Working directory was dropped/);
  });

  it('commitEntries mixes http, stdio, invalid and unknown keys', () => {
    const cfg = parseMcpConfigText(
      JSON.stringify({
        mcpServers: {
          web: { url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } },
          loc: { command: 'npx' },
          bad: 'nope',
        },
      })
    );
    const entries = new Map(cfg.entries.map((e) => [`0.${e.key}`, e]));
    const res = commitEntries(entries, ['0.0', '0.1', '0.2', '0.99', '0.0']);
    expect(res.drafts.map((d) => d.name)).toEqual(['web', 'loc']);
    expect(res.drafts[0]?.headers).toEqual([]);
    expect(res.drafts[0]?.auth).toMatchObject({
      type: 'bearer',
      bearer: { token: { kind: 'handle' } },
    });
    expect(res.skipped.map((s) => s.key)).toEqual(['0.2', '0.99']);
  });
});

describe('scanSourceFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-import-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('previews entries without secret values and skips absent optional files', async () => {
    const file = path.join(dir, 'claude_desktop_config.json');
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          gh: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_topsecret', LOG: 'x' } },
          web: { url: 'https://x.test', headers: { 'X-Api-Key': 'k-secret' } },
        },
      })
    );
    const { sources, entries } = await scanSourceFiles(
      [
        { label: 'Claude Desktop', file, optional: true },
        { label: 'Missing', file: path.join(dir, 'nope.json'), optional: true },
      ],
      dir
    );
    expect(sources).toHaveLength(1);
    expect(entries.size).toBe(2);
    const text = JSON.stringify(sources);
    expect(text).not.toContain('ghp_topsecret');
    expect(text).not.toContain('k-secret');
    expect(sources[0]?.location).toBe('~/claude_desktop_config.json');
    expect(sources[0]?.entries[0]?.env).toEqual([
      { name: 'GITHUB_TOKEN', secret: true },
      { name: 'LOG', value: 'x', secret: false },
    ]);
    expect(sources[0]?.entries[0]?.key).toBe('0.0');
  });

  it('reports oversize, malformed and non-file inputs as source errors', async () => {
    const big = path.join(dir, 'big.json');
    writeFileSync(big, `{"mcpServers":{},"pad":"${'a'.repeat(1024 * 1024)}"}`);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, '{oops');
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    const { sources, entries } = await scanSourceFiles(
      [
        { label: 'big', file: big, optional: false },
        { label: 'bad', file: bad, optional: false },
        { label: 'dir', file: sub, optional: false },
        { label: 'gone', file: path.join(dir, 'gone.json'), optional: false },
      ],
      dir
    );
    expect(entries.size).toBe(0);
    expect(sources.map((s) => s.error)).toEqual([
      expect.stringMatching(/larger than/),
      'File is not valid JSON',
      'Not a regular file',
      'Could not read the file',
    ]);
  });
});

describe('IPC channels', () => {
  const registered = new Map<string, Handler>();
  let dir: string;
  let homeBefore: string | undefined;

  const event = (id: number) => ({
    sender: Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
    senderFrame: { url: 'file:///app/dist/web/index.html' },
  });

  beforeAll(() => {
    registerMcpImportIPC(() => ({}) as never);
    for (const [channel, handler] of mockHandle.mock.calls) {
      registered.set(channel as string, handler as Handler);
    }
  });
  afterAll(() => unregisterMcpImportIPC());

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-import-ipc-'));
    homeBefore = process.env.HOME;
    mockShowOpenDialog.mockReset();
  });
  afterEach(() => {
    process.env.HOME = homeBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (channel: string, ev: unknown, payload?: unknown) => {
    const h = registered.get(channel);
    if (!h) throw new Error(`no handler ${channel}`);
    return h(ev, payload);
  };

  it('scan input has no path field: renderer-supplied paths are rejected', async () => {
    await expect(
      call('mcp:import:scan', event(1), { source: 'pick', path: '/etc/passwd' })
    ).rejects.toThrow(/Invalid IPC payload/);
    await expect(call('mcp:import:scan', event(1), { source: '/etc/passwd' })).rejects.toThrow(
      /Invalid IPC payload/
    );
    await expect(call('mcp:import:scan', event(1))).rejects.toThrow(/Invalid IPC payload/);
    expect(mockShowOpenDialog).not.toHaveBeenCalled();
  });

  it('pick: reads only the file chosen in the main-owned dialog; cancel yields nothing', async () => {
    const file = path.join(dir, 'mcp.json');
    writeFileSync(file, '{"servers":{"a":{"command":"npx"}}}');
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await call('mcp:import:scan', event(1), { source: 'pick' })).toEqual({
      sessionId: null,
      sources: [],
    });
    mockShowOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [file] });
    const res = (await call('mcp:import:scan', event(1), { source: 'pick' })) as {
      sessionId: string;
      sources: Array<{ entries: unknown[] }>;
    };
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.sources[0]?.entries).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'detect: reads only the well-known locations under the home directory',
    async () => {
      mkdirSync(path.join(dir, '.cursor'));
      writeFileSync(
        path.join(dir, '.cursor', 'mcp.json'),
        '{"mcpServers":{"c":{"url":"https://x.test"}}}'
      );
      process.env.HOME = dir;
      const res = (await call('mcp:import:scan', event(1), { source: 'detect' })) as {
        sources: Array<{ label: string; location: string }>;
      };
      expect(res.sources.map((s) => s.label)).toEqual(['Cursor (user)']);
      expect(res.sources[0]?.location).toBe('~/.cursor/mcp.json');
      expect(mockShowOpenDialog).not.toHaveBeenCalled();
    }
  );

  it('commit is owner-scoped and single-use; secrets become handles', async () => {
    const entries = new Map(
      stdioCfg({ command: 'npx', env: { API_KEY: 'plain-secret' } }).map((e) => [`0.${e.key}`, e])
    );
    const id = __seedMcpImportSessionForTests(7, entries);
    await expect(
      call('mcp:import:commit', event(8), { sessionId: id, keys: ['0.0'] })
    ).rejects.toThrow(/expired/);
    expect(__mcpImportSessionCountForTests()).toBeGreaterThan(0);

    const res = (await call('mcp:import:commit', event(7), { sessionId: id, keys: ['0.0'] })) as {
      drafts: unknown[];
    };
    expect(res.drafts).toHaveLength(1);
    expect(JSON.stringify(res)).not.toContain('plain-secret');
    await expect(
      call('mcp:import:commit', event(7), { sessionId: id, keys: ['0.0'] })
    ).rejects.toThrow(/expired/);
  });

  it('keeps the session when every selected entry is skipped so the dialog can retry', async () => {
    const entries = new Map(stdioCfg({ command: 'npx' }).map((e) => [`0.${e.key}`, e]));
    const id = __seedMcpImportSessionForTests(7, entries);
    const res = (await call('mcp:import:commit', event(7), {
      sessionId: id,
      keys: ['9.9'],
    })) as { drafts: unknown[]; skipped: unknown[] };
    expect(res.drafts).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    const retry = (await call('mcp:import:commit', event(7), {
      sessionId: id,
      keys: ['0.0'],
    })) as { drafts: unknown[] };
    expect(retry.drafts).toHaveLength(1);
  });

  it('commit validates ids and keys', async () => {
    for (const payload of [
      { sessionId: 'nope', keys: ['0.0'] },
      { sessionId: '3b5e8d4f-1c2a-4f7e-9d0b-1a2b3c4d5e6f', keys: [] },
      { sessionId: '3b5e8d4f-1c2a-4f7e-9d0b-1a2b3c4d5e6f', keys: ['../etc'] },
      { sessionId: '3b5e8d4f-1c2a-4f7e-9d0b-1a2b3c4d5e6f', keys: ['0.0'], approved: true },
    ]) {
      await expect(call('mcp:import:commit', event(1), payload)).rejects.toThrow(
        /Invalid IPC payload/
      );
    }
  });
});
