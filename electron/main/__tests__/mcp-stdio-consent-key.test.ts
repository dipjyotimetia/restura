// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    isAsyncEncryptionAvailable: async () => env.available,
    getSelectedStorageBackend: () => env.backend,
    encryptStringAsync: async (s: string) =>
      Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
    decryptStringAsync: async (b: Buffer) => {
      const text = b.toString();
      if (!text.startsWith('sealed:')) throw new Error('bad blob');
      return { result: Buffer.from(text.slice(7), 'base64').toString(), shouldReEncrypt: false };
    },
  },
  dialog: { showMessageBox: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
}));

import {
  __setStdioConsentMacKeyProviderForTests,
  canRememberStdioConsent,
  primeStdioConsentMacKey,
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
  it('mints a random key, stores it sealed, and reuses it across restarts', async () => {
    await primeStdioConsentMacKey();
    const first = stdioConsentKey(spec);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const blob = readFileSync(keyFile()).toString();
    expect(blob.startsWith('sealed:')).toBe(true);
    __setStdioConsentMacKeyProviderForTests(null); // simulate restart (drop cache)
    await primeStdioConsentMacKey();
    expect(stdioConsentKey(spec)).toBe(first);
    rmSync(env.userData, { recursive: true, force: true });
  });

  it('an undecryptable key file is left alone and approvals are off for the session', async () => {
    await primeStdioConsentMacKey();
    expect(stdioConsentKey(spec)).not.toBeNull();
    writeFileSync(keyFile(), 'not-a-sealed-blob');
    __setStdioConsentMacKeyProviderForTests(null);
    await primeStdioConsentMacKey();
    expect(stdioConsentKey(spec)).toBeNull();
    expect(readFileSync(keyFile()).toString()).toBe('not-a-sealed-blob');
  });

  it('a non-ENOENT read error does not mint a new key', async () => {
    // A directory where the key file should be: readFileSync fails with EISDIR.
    mkdirSync(keyFile());
    await primeStdioConsentMacKey();
    expect(stdioConsentKey(spec)).toBeNull();
  });

  it('is unavailable without safeStorage, or with the Linux basic_text backend', async () => {
    env.available = false;
    await primeStdioConsentMacKey();
    expect(canRememberStdioConsent()).toBe(false);
    __setStdioConsentMacKeyProviderForTests(null);
    env.available = true;
    env.backend = 'basic_text';
    await primeStdioConsentMacKey();
    expect(stdioConsentKey(spec)).toBeNull();
  });

  it('fails closed (no remembered approvals) until the key has been primed', () => {
    expect(canRememberStdioConsent()).toBe(false);
    expect(stdioConsentKey(spec)).toBeNull();
  });
});
