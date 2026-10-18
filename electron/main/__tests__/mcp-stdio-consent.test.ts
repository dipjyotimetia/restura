// @vitest-environment node
import * as crypto from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mockShowMessageBox = vi.hoisted(() => vi.fn());
const mockFromWebContents = vi.hoisted(() => vi.fn(() => null as unknown));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/unused-user-data' },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: { showMessageBox: mockShowMessageBox },
  BrowserWindow: { fromWebContents: mockFromWebContents },
}));

import {
  __setStdioConsentMacKeyProviderForTests,
  __setStdioConsentStoreForTests,
  CONSENT_DISPLAY_MAX_CHARS,
  type ConsentStoreShape,
  canonicalStdioLaunch,
  canRememberStdioConsent,
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

const MAC_KEY = crypto.randomBytes(32);
const plain = (value: string) => ({ kind: 'plain' as const, value });

const spec: StdioLaunchSpec = {
  command: 'npx',
  resolvedPath: '/usr/local/bin/npx',
  viaCmd: false,
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/project'],
  cwd: '/Users/me',
  env: {
    LOG_LEVEL: plain('debug'),
    TOKEN: { kind: 'handle', id: 'h-1', label: 'gh', digest: 'd1' },
  },
};

let store: ReturnType<typeof memoryStore>;

beforeEach(() => {
  store = memoryStore();
  __setStdioConsentStoreForTests(store);
  __setStdioConsentMacKeyProviderForTests(() => MAC_KEY);
  mockShowMessageBox.mockReset();
});

afterAll(() => {
  __setStdioConsentStoreForTests(null);
  __setStdioConsentMacKeyProviderForTests(null);
});

describe('stdioConsentKey', () => {
  it('is an HMAC of the canonical launch, stable across env insertion order', () => {
    const reordered: StdioLaunchSpec = {
      ...spec,
      env: { TOKEN: spec.env.TOKEN!, LOG_LEVEL: plain('debug') },
    };
    expect(stdioConsentKey(reordered)).toBe(stdioConsentKey(spec));
    const expected = crypto
      .createHmac('sha256', MAC_KEY)
      .update(canonicalStdioLaunch(spec))
      .digest('hex');
    expect(stdioConsentKey(spec)).toBe(expected);
  });

  it('differs from an unkeyed hash a renderer could compute', () => {
    const unkeyed = crypto.createHash('sha256').update(canonicalStdioLaunch(spec)).digest('hex');
    expect(stdioConsentKey(spec)).not.toBe(unkeyed);
  });

  it.each<[string, Partial<StdioLaunchSpec>]>([
    ['resolved program path', { resolvedPath: '/opt/evil/npx' }],
    ['cmd.exe routing', { viaCmd: true }],
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
    ['an env value', { env: { ...spec.env, LOG_LEVEL: plain('trace') } }],
    ['an added env var', { env: { ...spec.env, NPM_CONFIG_REGISTRY: plain('https://x.test') } }],
    [
      'the secret handle id',
      { env: { ...spec.env, TOKEN: { kind: 'handle', id: 'h-2', digest: 'd1' } } },
    ],
    [
      'the secret value (rotation)',
      { env: { ...spec.env, TOKEN: { kind: 'handle', id: 'h-1', digest: 'd2' } } },
    ],
  ])('changes when %s changes', (_label, patch) => {
    expect(stdioConsentKey({ ...spec, ...patch })).not.toBe(stdioConsentKey(spec));
  });

  it('ignores the display command (only the resolved path matters) and handle labels', () => {
    expect(stdioConsentKey({ ...spec, command: '/usr/local/bin/npx' })).toBe(stdioConsentKey(spec));
    expect(
      stdioConsentKey({
        ...spec,
        env: { ...spec.env, TOKEN: { kind: 'handle', id: 'h-1', label: 'other', digest: 'd1' } },
      })
    ).toBe(stdioConsentKey(spec));
  });

  it('is null without a main-only MAC key', () => {
    __setStdioConsentMacKeyProviderForTests(() => null);
    expect(stdioConsentKey(spec)).toBeNull();
    expect(canRememberStdioConsent()).toBe(false);
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
    expect(Object.values(store.data)[0]).toMatchObject({ command: '/usr/local/bin/npx' });
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

  it('forged store entries do not pre-approve (no MAC key, no match)', async () => {
    // Everything a compromised renderer could compute: the canonical form,
    // its plain SHA-256, and the previous unkeyed key format.
    const canonical = canonicalStdioLaunch(spec);
    for (const forged of [
      crypto.createHash('sha256').update(canonical).digest('hex'),
      crypto.createHmac('sha256', Buffer.alloc(32)).update(canonical).digest('hex'),
      canonical,
    ]) {
      store.set(forged, { approvedAt: Date.now(), command: 'npx' });
    }
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    expect(await ensureStdioConsent(spec)).toBe('denied');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
  });

  it('an imported payload carrying approval fields still prompts', async () => {
    const imported = {
      ...spec,
      approved: true,
      consentKey: stdioConsentKey(spec),
    } as StdioLaunchSpec;
    mockShowMessageBox.mockResolvedValue({ response: 0 });
    expect(await ensureStdioConsent(imported)).toBe('denied');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
  });

  it('fails closed without safeStorage: no "Always allow", nothing remembered', async () => {
    __setStdioConsentMacKeyProviderForTests(() => null);
    mockShowMessageBox.mockResolvedValue({ response: 2 }); // out-of-range for 2 buttons
    expect(await ensureStdioConsent(spec)).toBe('denied');
    const options = mockShowMessageBox.mock.calls[0]!.at(-1) as {
      buttons: string[];
      detail: string;
    };
    expect(options.buttons).toEqual(['Cancel', 'Allow once']);
    expect(options.detail).toMatch(/OS keychain is unavailable/);
    mockShowMessageBox.mockResolvedValue({ response: 1 });
    expect(await ensureStdioConsent(spec)).toBe('once');
    expect(Object.keys(store.data)).toHaveLength(0);
  });

  it('serializes prompts and dedupes concurrent requests from the same requester', async () => {
    let resolve!: (v: { response: number }) => void;
    mockShowMessageBox.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const a = ensureStdioConsent(spec, undefined, 'conn-a');
    const b = ensureStdioConsent(spec, undefined, 'conn-a');
    await new Promise((r) => setTimeout(r, 0));
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    resolve({ response: 2 });
    expect(await a).toBe('always');
    expect(await b).toBe('always');
  });

  it('does not share an "Allow once" across different connections', async () => {
    mockShowMessageBox
      .mockResolvedValueOnce({ response: 1 })
      .mockResolvedValueOnce({ response: 0 });
    const [a, b] = await Promise.all([
      ensureStdioConsent(spec, undefined, 'conn-a'),
      ensureStdioConsent(spec, undefined, 'conn-b'),
    ]);
    expect(a).toBe('once');
    expect(b).toBe('denied');
    expect(mockShowMessageBox).toHaveBeenCalledTimes(2);
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

  it('a launch with truncated display can only be allowed once', async () => {
    const long = { ...spec, args: ['x'.repeat(CONSENT_DISPLAY_MAX_CHARS + 10)] };
    mockShowMessageBox.mockResolvedValue({ response: 2 });
    expect(await ensureStdioConsent(long)).toBe('denied');
    const options = mockShowMessageBox.mock.calls[0]!.at(-1) as { buttons: string[] };
    expect(options.buttons).toEqual(['Cancel', 'Allow once']);
    expect(hasStdioConsent(long)).toBe(false);
  });

  it('revokeAllStdioConsents clears approvals', async () => {
    mockShowMessageBox.mockResolvedValue({ response: 2 });
    await ensureStdioConsent(spec);
    expect(revokeAllStdioConsents()).toBe(1);
    expect(hasStdioConsent(spec)).toBe(false);
  });
});

describe('formatStdioConsentDetail', () => {
  it('shows the program, every argument, and plain values in full; hides only credential-named ones', () => {
    const { detail, truncated } = formatStdioConsentDetail({
      ...spec,
      args: ['--root', 'a dir/with "quotes"'],
      env: {
        API_KEY: plain('super-secret'),
        LOG_LEVEL: plain('debug'),
        NODE_OPTIONS: plain('--max-old-space-size=512'),
        GIT_TOKEN: plain('shown-because-sensitive'),
        TOKEN: { kind: 'handle', id: 'h-1', label: 'gh', digest: 'd' },
      },
    });
    expect(truncated).toBe(false);
    expect(detail).toContain('Program: "/usr/local/bin/npx"');
    expect(detail).toContain('(requested as "npx")');
    expect(detail).toContain('[0] "--root"');
    expect(detail).toContain('[1] "a dir/with \\"quotes\\""');
    expect(detail).toContain('Working directory: "/Users/me"');
    expect(detail).toContain('LOG_LEVEL = "debug"');
    expect(detail).toContain('NODE_OPTIONS = "--max-old-space-size=512"');
    expect(detail).toContain('GIT_TOKEN = "shown-because-sensitive"');
    expect(detail).toContain('API_KEY = <12 characters, hidden>');
    expect(detail).not.toContain('super-secret');
    expect(detail).toContain('TOKEN = <from the secret store: "gh">');
  });

  it('escapes control/format/separator characters at the display sink', () => {
    const { detail } = formatStdioConsentDetail({
      ...spec,
      resolvedPath: '/opt/bin/\u202Etxt.exe',
      cwd: '/home/me\u2028/x',
      env: {
        TOKEN: { kind: 'handle', id: 'h', label: 'prod\u202Ekey', digest: 'd' },
        NOTE: plain('line1\nline2\tend'),
      },
    });
    expect(detail).not.toMatch(/[\u202E\u2028]/);
    expect(detail).toContain('\\u{202E}txt.exe');
    expect(detail).toContain('/home/me\\u{2028}/x');
    expect(detail).toContain('prod\\u{202E}key');
    expect(detail).toContain('NOTE = "line1\\nline2\\tend"');
  });

  it('never hides a path-like value, even under a credential-like name', () => {
    const { detail } = formatStdioConsentDetail({
      ...spec,
      env: {
        SECRET_FILE: plain('/home/me/.ssh/id_ed25519'),
        WIN_KEY: plain('C:\\keys\\a.pem'),
        API_KEY: plain('abc'),
      },
    });
    expect(detail).toContain('SECRET_FILE = "/home/me/.ssh/id_ed25519"');
    expect(detail).toContain('WIN_KEY = "C:\\\\keys\\\\a.pem"');
    expect(detail).toContain('API_KEY = <3 characters, hidden>');
  });

  it('notes cmd.exe routing', () => {
    expect(formatStdioConsentDetail({ ...spec, viaCmd: true }).detail).toMatch(/cmd\.exe/);
  });

  it('cuts long values with an explicit marker', () => {
    const { detail, truncated } = formatStdioConsentDetail({
      ...spec,
      args: ['a'.repeat(CONSENT_DISPLAY_MAX_CHARS + 25)],
    });
    expect(truncated).toBe(true);
    expect(detail).toContain('25 more characters not shown');
    expect(detail).toMatch(/can only be allowed once/);
  });

  it('caps the overall detail size', () => {
    const { detail, truncated } = formatStdioConsentDetail({
      ...spec,
      args: Array.from({ length: 128 }, () => 'b'.repeat(200)),
    });
    expect(truncated).toBe(true);
    expect(detail.length).toBeLessThan(9 * 1024);
    expect(detail).toMatch(/more lines not shown/);
  });

  it('says when there are no arguments or env', () => {
    const { detail } = formatStdioConsentDetail({
      command: '/usr/bin/srv',
      resolvedPath: '/usr/bin/srv',
      viaCmd: false,
      args: [],
      cwd: '/',
      env: {},
    });
    expect(detail).toContain('Arguments: (none)');
    expect(detail).toContain('Extra environment: (none)');
    expect(detail).not.toContain('requested as');
  });
});
