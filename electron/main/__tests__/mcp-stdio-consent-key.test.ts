// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  userData: '',
  available: true,
  backend: 'keychain' as string,
}));

// A reversible stand-in for the OS keychain: sealing is not plaintext.
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  safeStorage: {
    isEncryptionAvailable: () => env.available,
    getSelectedStorageBackend: () => env.backend,
    encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => {
      const text = b.toString();
      if (!text.startsWith('sealed:')) throw new Error('bad blob');
      return Buffer.from(text.slice(7), 'base64').toString();
    },
  },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
}));

import {
  __setStdioConsentMacKeyProviderForTests,
  canRememberStdioConsent,
  type StdioLaunchSpec,
  stdioConsentKey,
} from '../security/mcp-stdio-consent';

const spec: StdioLaunchSpec = {
  command: 'srv',
  resolvedPath: '/usr/bin/srv',
  viaCmd: false,
  args: [],
  cwd: '/',
  env: {},
};
const keyFile = () => path.join(env.userData, '.mcp-stdio-consent-key');

beforeEach(() => {
  env.userData = mkdtempSync(path.join(tmpdir(), 'consent-key-'));
  env.available = true;
  env.backend = 'keychain';
  __setStdioConsentMacKeyProviderForTests(null); // reset to the real provider, clear cache
});

afterAll(() => __setStdioConsentMacKeyProviderForTests(null));

describe('stdio consent MAC key (safeStorage-sealed)', () => {
  it('mints a random key, stores it sealed, and reuses it across restarts', () => {
    const first = stdioConsentKey(spec);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const blob = readFileSync(keyFile()).toString();
    expect(blob.startsWith('sealed:')).toBe(true);
    __setStdioConsentMacKeyProviderForTests(null); // simulate restart (drop cache)
    expect(stdioConsentKey(spec)).toBe(first);
    rmSync(env.userData, { recursive: true, force: true });
  });

  it('a tampered key file is replaced, so old approvals stop verifying (fail closed)', () => {
    const first = stdioConsentKey(spec);
    writeFileSync(keyFile(), 'not-a-sealed-blob');
    __setStdioConsentMacKeyProviderForTests(null);
    expect(stdioConsentKey(spec)).not.toBe(first);
  });

  it('is unavailable without safeStorage, or with the Linux basic_text backend', () => {
    env.available = false;
    expect(canRememberStdioConsent()).toBe(false);
    __setStdioConsentMacKeyProviderForTests(null);
    env.available = true;
    env.backend = 'basic_text';
    expect(stdioConsentKey(spec)).toBeNull();
  });
});
