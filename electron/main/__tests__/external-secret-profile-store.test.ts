// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const records = new Map<string, unknown>();
const fakeStore = {
  get: (key: string) => records.get(key),
  set: (key: string, value: unknown) => void records.set(key, value),
  clear: () => records.clear(),
};

vi.mock('../security/encrypted-key', () => ({ getOrCreateEncryptedKey: vi.fn(() => 'test-key') }));
vi.mock('../security/external-secret-providers', () => ({
  replaceExternalSecretProfiles: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

import {
  __setExternalSecretProfileStoreForTests,
  clearExternalSecretProfiles,
  createExternalSecretProfile,
  deleteExternalSecretProfile,
  listExternalSecretProfiles,
  updateExternalSecretProfile,
} from '../security/external-secret-profile-store';

describe('external-secret-profile-store', () => {
  beforeEach(() => {
    records.clear();
    __setExternalSecretProfileStoreForTests(fakeStore);
  });

  it('persists metadata only, updates it, and removes it without retaining a stale profile', () => {
    const profile = createExternalSecretProfile({
      provider: 'aws-secrets-manager',
      label: 'Production',
      region: 'ap-southeast-2',
      auth: { kind: 'named-profile', profile: 'production' },
    });
    expect(profile.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(listExternalSecretProfiles()).toEqual([profile]);

    const updated = { ...profile, label: 'Production read-only' };
    updateExternalSecretProfile(updated);
    expect(listExternalSecretProfiles()).toEqual([updated]);

    deleteExternalSecretProfile(profile.id);
    expect(listExternalSecretProfiles()).toEqual([]);
  });

  it('clears profiles during the desktop reset path', () => {
    createExternalSecretProfile({
      provider: 'azure-key-vault',
      vaultName: 'team-vault',
      auth: { kind: 'named-profile' },
    });
    clearExternalSecretProfiles();
    expect(listExternalSecretProfiles()).toEqual([]);
  });
});
