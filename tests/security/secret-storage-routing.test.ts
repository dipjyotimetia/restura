import { describe, it, expect, vi, beforeEach } from 'vitest';

// Force the desktop branch of secureStorage so the routing decision
// (encrypted electron-store vs. plaintext localStorage) is observable.
vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: () => null,
}));

import { secureStorage } from '@/lib/shared/secure-storage';
import { kafkaSecretKey, type KafkaSecretField } from '@/features/kafka/lib/kafkaManager';
import { mqttSecretKey, type MqttSecretField } from '@/features/mqtt/lib/mqttManager';

/**
 * On desktop, secureStorage sends "sensitive" keys to the encrypted
 * electron-store (safeStorage → OS keychain) and everything else to plaintext
 * localStorage. Secret material MUST take the encrypted path. Kafka/MQTT derive
 * their secret keys via kafkaSecretKey/mqttSecretKey; a key that fails the
 * sensitivity check would silently persist plaintext secrets at rest. This
 * pins the contract for every secret-bearing key those builders produce —
 * including TLS passphrases, whose key word ("passphrase") must be recognised.
 */
const storeSet = vi.fn();

beforeEach(() => {
  storeSet.mockReset();
  (window as unknown as { electron: { store: Record<string, unknown> } }).electron = {
    store: { set: storeSet, get: vi.fn().mockResolvedValue(null), delete: vi.fn(), clear: vi.fn() },
  };
  localStorage.clear();
});

// Driven off the field-type unions: adding a new secret field without a `true`
// entry here fails to compile, so a new key can't slip past both the regex and
// this routing guard at once.
const KAFKA_FIELDS: Record<KafkaSecretField, true> = {
  'sasl-password': true,
  'tls-passphrase': true,
  'registry-password': true,
  'registry-token': true,
};
const MQTT_FIELDS: Record<MqttSecretField, true> = {
  password: true,
  'tls-passphrase': true,
};
const SECRET_KEYS = [
  ...(Object.keys(KAFKA_FIELDS) as KafkaSecretField[]).map((f) => kafkaSecretKey('conn-1', f)),
  ...(Object.keys(MQTT_FIELDS) as MqttSecretField[]).map((f) => mqttSecretKey('conn-1', f)),
];

describe('secret storage routing (desktop)', () => {
  it.each(SECRET_KEYS)('routes %s to the encrypted store, never plaintext localStorage', (key) => {
    secureStorage.set(key, 'super-secret-value');
    expect(storeSet).toHaveBeenCalledWith(key, 'super-secret-value');
    // The defining security property: the secret must not be readable from the
    // renderer's plaintext localStorage.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('still sends a genuinely non-secret key to localStorage', () => {
    secureStorage.set('restura:onboarding-complete', 'true');
    expect(localStorage.getItem('restura:onboarding-complete')).toBe('true');
    expect(storeSet).not.toHaveBeenCalled();
  });

  it('migrates a pre-existing plaintext secret into the encrypted store on read', () => {
    // Simulate a value written before the key counted as sensitive (the bug).
    const key = kafkaSecretKey('legacy-conn', 'tls-passphrase');
    localStorage.setItem(key, 'leaked-in-plaintext');

    const value = secureStorage.get(key);

    expect(value).toBe('leaked-in-plaintext'); // recovered — no silent data loss
    expect(storeSet).toHaveBeenCalledWith(key, 'leaked-in-plaintext'); // moved to secure store
    expect(localStorage.getItem(key)).toBeNull(); // plaintext purged
  });

  it('purges any stale plaintext copy when a sensitive key is written', () => {
    const key = mqttSecretKey('legacy-conn-2', 'tls-passphrase');
    localStorage.setItem(key, 'old-plaintext');

    secureStorage.set(key, 'fresh-value');

    expect(storeSet).toHaveBeenCalledWith(key, 'fresh-value');
    expect(localStorage.getItem(key)).toBeNull();
  });

  it('removing a sensitive key also drops any stale plaintext copy', () => {
    // Otherwise a later get() would migrate the plaintext back, resurrecting a
    // removed secret.
    const key = kafkaSecretKey('legacy-conn-3', 'tls-passphrase');
    localStorage.setItem(key, 'to-be-removed');

    secureStorage.remove(key);

    expect(localStorage.getItem(key)).toBeNull();
  });
});
