import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResilientStore } from '../storage/resilient-store';
import { __setVaultStoreForTests, vaultGet, vaultSet, vaultUnset } from '../storage/vault-handler';

// conf 16 throws for dot-notation keys it cannot parse; the vault must answer
// with a clean { ok:false } rather than letting the IPC handler throw.
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-keys-'));
  __setVaultStoreForTests(createResilientStore({ name: 'v', cwd: dir }) as never);
});
afterEach(() => {
  __setVaultStoreForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('vault keys conf cannot parse', () => {
  for (const key of ['a[x', 'a[', 'a[0', '[x]']) {
    it(`rejects ${JSON.stringify(key)} without throwing`, () => {
      expect(vaultSet(key, 'v')).toMatchObject({ ok: false, error: expect.any(String) });
      expect(vaultUnset(key)).toMatchObject({ ok: false, error: expect.any(String) });
      expect(vaultGet(key)).toMatchObject({ ok: false, value: null, error: expect.any(String) });
    });
  }

  it('leaves keys conf accepts (a..b, a., a], .a) working as before', () => {
    for (const key of ['a..b', 'a.', 'a]', '.a']) {
      expect(vaultSet(key, 'v')).toEqual({ ok: true });
      expect(vaultGet(key)).toEqual({ value: 'v' });
      expect(vaultUnset(key)).toEqual({ ok: true });
    }
  });

  it('still round-trips existing dotted nested keys', () => {
    expect(vaultSet('a.b', 'v1')).toEqual({ ok: true });
    expect(vaultGet('a.b')).toEqual({ value: 'v1' });
    expect(vaultSet('my-team.api.token', 'v2')).toEqual({ ok: true });
    expect(vaultGet('my-team.api.token')).toEqual({ value: 'v2' });
    expect(vaultUnset('a.b')).toEqual({ ok: true });
    expect(vaultGet('a.b')).toEqual({ value: null });
  });
});
