// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockShowMessageBox = vi.hoisted(() => vi.fn());
const mockFromWebContents = vi.hoisted(() => vi.fn(() => null as unknown));

vi.mock('electron', () => ({
  dialog: { showMessageBox: mockShowMessageBox },
  BrowserWindow: { fromWebContents: mockFromWebContents },
}));

import {
  __setStdioConsentStoreForTests,
  type ConsentStoreShape,
  ensureStdioConsent,
  formatStdioConsentDetail,
  hasStdioConsent,
  revokeAllStdioConsents,
  type StdioLaunchSpec,
  stdioConsentKey,
} from '../security/mcp-stdio-consent';

function memoryStore(): ConsentStoreShape & {
  data: Record<string, { approvedAt: number; command: string }>;
} {
  const data: Record<string, { approvedAt: number; command: string }> = {};
  return {
    data,
    get: (k) => data[k],
    set: (k, v) => {
      data[k] = v;
    },
    has: (k) => k in data,
    clear: () => {
      for (const k of Object.keys(data)) delete data[k];
    },
    get store() {
      return data;
    },
  };
}

const spec: StdioLaunchSpec = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/project'],
  cwd: '/Users/me',
  env: { LOG_LEVEL: 'debug', TOKEN: { kind: 'handle', id: 'h-1', label: 'gh' } },
};

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  store = memoryStore();
  __setStdioConsentStoreForTests(store);
  mockShowMessageBox.mockReset();
});

afterAll(() => __setStdioConsentStoreForTests(null));

describe('stdioConsentKey', () => {
  it('is stable and independent of env insertion order', () => {
    const reordered: StdioLaunchSpec = {
      ...spec,
      env: { TOKEN: spec.env.TOKEN!, LOG_LEVEL: 'debug' },
    };
    expect(stdioConsentKey(reordered)).toBe(stdioConsentKey(spec));
    expect(stdioConsentKey(spec)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, Partial<StdioLaunchSpec>]>([
    ['command', { command: 'uvx' }],
    ['an argument', { args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] }],
    [
      'argument order',
      { args: ['@modelcontextprotocol/server-filesystem', '-y', '/Users/me/project'] },
    ],
    ['an extra argument', { args: [...spec.args, '--write'] }],
    [
      'arg boundaries',
      { args: ['-y @modelcontextprotocol/server-filesystem', '/Users/me/project'] },
    ],
    ['cwd', { cwd: '/tmp' }],
    ['an env value', { env: { ...spec.env, LOG_LEVEL: 'trace' } }],
    ['an added env var', { env: { ...spec.env, NPM_CONFIG_REGISTRY: 'https://evil.example' } }],
    ['the secret handle id', { env: { ...spec.env, TOKEN: { kind: 'handle', id: 'h-2' } } }],
  ])('changes when %s changes', (_label, patch) => {
    expect(stdioConsentKey({ ...spec, ...patch })).not.toBe(stdioConsentKey(spec));
  });

  it('treats a plain value and an inline SecretRef with the same value identically', () => {
    expect(
      stdioConsentKey({
        ...spec,
        env: { ...spec.env, LOG_LEVEL: { kind: 'inline', value: 'debug' } },
      })
    ).toBe(stdioConsentKey(spec));
  });

  it('distinguishes a handle id from a literal value of the same text', () => {
    expect(stdioConsentKey({ ...spec, env: { TOKEN: 'h-1' } })).not.toBe(
      stdioConsentKey({ ...spec, env: { TOKEN: { kind: 'handle', id: 'h-1' } } })
    );
  });
});

describe('ensureStdioConsent', () => {
  it('prompts for an unseen launch and persists "Always allow"', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 2 });
    expect(await ensureStdioConsent(spec)).toBe('always');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(hasStdioConsent(spec)).toBe(true);
    expect(await ensureStdioConsent(spec)).toBe('always');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(Object.values(store.data)[0]).toMatchObject({ command: 'npx' });
  });

  it('"Allow once" is not persisted', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 1 });
    expect(await ensureStdioConsent(spec)).toBe('once');
    expect(hasStdioConsent(spec)).toBe(false);
    await ensureStdioConsent(spec);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('Cancel / dismiss denies and persists nothing', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    expect(await ensureStdioConsent(spec)).toBe('denied');
    expect(Object.keys(store.data)).toHaveLength(0);
  });

  it('an approval for one command line never covers another', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 2 });
    await ensureStdioConsent(spec);
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    expect(await ensureStdioConsent({ ...spec, args: [...spec.args, '--allow-write'] })).toBe(
      'denied'
    );
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
  });

  it('nothing outside the main-owned store can pre-approve (imported data has no write path)', async () => {
    // Simulate an imported collection carrying a pre-computed key/flag: the
    // only inputs ensureStdioConsent accepts are the launch spec and owner, so
    // the decision still comes from the dialog.
    const imported = {
      ...spec,
      approved: true,
      consentKey: stdioConsentKey(spec),
    } as StdioLaunchSpec;
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    expect(await ensureStdioConsent(imported)).toBe('denied');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
  });

  it('serializes prompts and dedupes concurrent requests for the same launch', async () => {
    let resolve!: (v: { response: number }) => void;
    mockShowMessageBox.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const a = ensureStdioConsent(spec);
    const b = ensureStdioConsent(spec);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    resolve({ response: 2 });
    expect(await a).toBe('always');
    expect(await b).toBe('always');
  });

  it('parents the dialog to the owning window when there is one', async () => {
    const win = { id: 'win' };
    mockFromWebContents.mockReturnValueOnce(win);
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    const owner = { isDestroyed: () => false } as unknown as Electron.WebContents;
    await ensureStdioConsent(spec, owner);
    expect(mockShowMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ cancelId: 0, defaultId: 0, type: 'warning' })
    );
  });

  it('revokeAllStdioConsents clears approvals', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 2 });
    await ensureStdioConsent(spec);
    expect(revokeAllStdioConsents()).toBe(1);
    expect(hasStdioConsent(spec)).toBe(false);
  });
});

describe('formatStdioConsentDetail', () => {
  it('shows the exact command line, quoted, and hides non-sensitive env values', () => {
    const detail = formatStdioConsentDetail({
      ...spec,
      args: ['--root', 'a dir/with "quotes"'],
      env: {
        API_KEY: 'super-secret',
        NODE_OPTIONS: '--require /tmp/x.js',
        TOKEN: { kind: 'handle', id: 'h-1', label: 'gh' },
      },
    });
    expect(detail).toContain('Command: "npx"');
    expect(detail).toContain('[0] "--root"');
    expect(detail).toContain('[1] "a dir/with \\"quotes\\""');
    expect(detail).toContain('Working directory: "/Users/me"');
    expect(detail).toContain('NODE_OPTIONS = "--require /tmp/x.js"');
    expect(detail).toContain('API_KEY = <12 characters, hidden>');
    expect(detail).not.toContain('super-secret');
    expect(detail).toContain('TOKEN = <secret handle: gh>');
  });

  it('says when there are no arguments or env', () => {
    const detail = formatStdioConsentDetail({
      command: '/usr/bin/srv',
      args: [],
      cwd: '/',
      env: {},
    });
    expect(detail).toContain('Arguments: (none)');
    expect(detail).toContain('Extra environment: (none)');
  });
});
