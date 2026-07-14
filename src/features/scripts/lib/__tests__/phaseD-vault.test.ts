import { describe, expect, it, vi } from 'vitest';
import type { PmVaultAdapter } from '../scriptExecutor';
import ScriptExecutor from '../scriptExecutor';

/**
 * Phase D — pm.vault binding contract.
 *
 * `pm.vault.{get,set,unset}` MUST be async (return promises). The
 * executor wraps `host.vault.*` calls with QuickJS deferred promises so
 * the user can `await` them inside a script. If no `host.vault` is wired
 * in (web build, CLI without a jar), each method rejects with a clean
 * "no host adapter" error — scripts fail loudly instead of hanging.
 */

function buildVaultAdapter(seed: Record<string, string> = {}): PmVaultAdapter {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async unset(key) {
      store.delete(key);
    },
  };
}

describe('pm.vault — host bridge', () => {
  it('await pm.vault.get / .set / .unset round-trips through the adapter', async () => {
    const adapter = buildVaultAdapter({ existing: 'persisted' });
    const ex = new ScriptExecutor({ host: { vault: adapter } });
    const r = await ex.executeScript(
      `
      (async function () {
        pm.test('initial', async function () {
          pm.expect(await pm.vault.get('existing')).to.equal('persisted');
        });
        await pm.vault.set('TOKEN', 'abc');
        pm.test('after set', async function () {
          pm.expect(await pm.vault.get('TOKEN')).to.equal('abc');
        });
        await pm.vault.unset('TOKEN');
        pm.test('after unset', async function () {
          pm.expect(await pm.vault.get('TOKEN')).to.be.undefined;
        });
      })();
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('no host.vault bound: get/set/unset reject with a clean message', async () => {
    const ex = new ScriptExecutor({});
    const r = await ex.executeScript(
      `
      (async function () {
        try {
          await pm.vault.get('x');
          pm.test('unreachable', function () { pm.expect.fail('should have thrown'); });
        } catch (e) {
          pm.test('rejected', function () {
            pm.expect(String(e.message)).to.match(/no host adapter/);
          });
        }
      })();
    `,
      {}
    );
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });

  it('host rejection surfaces as a thrown error inside await', async () => {
    const failing: PmVaultAdapter = {
      get: vi.fn(async () => {
        throw new Error('keychain unlock denied');
      }),
      set: vi.fn(async () => undefined),
      unset: vi.fn(async () => undefined),
    };
    const ex = new ScriptExecutor({ host: { vault: failing } });
    const r = await ex.executeScript(
      `
      (async function () {
        try {
          await pm.vault.get('x');
          pm.test('unreachable', function () { pm.expect.fail('should have thrown'); });
        } catch (e) {
          pm.test('caught', function () {
            pm.expect(String(e.message)).to.match(/keychain unlock denied/);
          });
        }
      })();
    `,
      {}
    );
    expect(failing.get).toHaveBeenCalledTimes(1);
    expect(r.tests?.every((t) => t.passed)).toBe(true);
  });
});
