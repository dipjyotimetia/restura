import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  brokerSecretHandleId,
  brokerSecretRef,
  copyBrokerSecret,
  ensureBrokerSecret,
  putBrokerSecret,
  removeBrokerSecret,
} from '@/lib/shared/broker-secrets';
import {
  type FakeSecretHandles,
  installFakeSecretHandles,
} from '../../../../tests/helpers/fakeSecretHandles';

const vault = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/shared/secure-storage', () => ({
  secureStorage: {
    getAsync: async (key: string) => vault.get(key) ?? null,
    remove: (key: string) => vault.delete(key),
  },
}));

describe('broker-secrets (SEC-K3)', () => {
  let secrets: FakeSecretHandles;
  beforeEach(() => {
    vault.clear();
    secrets = installFakeSecretHandles();
  });
  afterEach(() => secrets.uninstall());

  it('derives a stable UUID handle id per storage key', () => {
    const id = brokerSecretHandleId('mqtt:c1:password');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(brokerSecretHandleId('mqtt:c1:password')).toBe(id);
    expect(brokerSecretHandleId('mqtt:c2:password')).not.toBe(id);
    expect(brokerSecretRef('mqtt:c1:password')).toEqual({ kind: 'handle', id });
  });

  it('stores, detects and removes a secret without reading it back', async () => {
    await putBrokerSecret('mqtt:c1:password', 'pw', 'MQTT password');
    expect(secrets.valueFor('mqtt:c1:password')).toBe('pw');
    expect(await ensureBrokerSecret('mqtt:c1:password')).toBe(true);
    await removeBrokerSecret('mqtt:c1:password');
    expect(await ensureBrokerSecret('mqtt:c1:password')).toBe(false);
  });

  it('migrates a legacy secureStorage value into a handle once and deletes the legacy copy', async () => {
    vault.set('kafka:c1:sasl-password', 'legacy');
    expect(await ensureBrokerSecret('kafka:c1:sasl-password')).toBe(true);
    expect(secrets.valueFor('kafka:c1:sasl-password')).toBe('legacy');
    expect(vault.has('kafka:c1:sasl-password')).toBe(false);
  });

  it('copies in main and clears the target when the source is empty', async () => {
    secrets.seed('mqtt:a:password', 'pw');
    expect(await copyBrokerSecret('mqtt:a:password', 'mqtt:b:password')).toBe(true);
    expect(secrets.valueFor('mqtt:b:password')).toBe('pw');
    expect(await copyBrokerSecret('mqtt:none:password', 'mqtt:b:password')).toBe(false);
    expect(secrets.valueFor('mqtt:b:password')).toBeUndefined();
  });
});
