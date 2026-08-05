/** Encrypted persistence and renderer-safe IPC for external provider profiles. */
import * as crypto from 'crypto';
import { ipcMain } from 'electron';
import {
  externalSecretProfileListSchema,
  type ExternalSecretProfile,
  type ExternalSecretProfileInput,
} from '@shared/secrets/external-secret-profile';
import { IPC } from '../../shared/channels';
import {
  createValidatedHandler,
  ExternalSecretProfileCreateSchema,
  ExternalSecretProfileDeleteSchema,
  ExternalSecretProfileUpdateSchema,
  NoInputSchema,
} from '../ipc/ipc-validators';
import { getOrCreateEncryptedKey } from './encrypted-key';
import { replaceExternalSecretProfiles } from './external-secret-providers';

const Store = require('electron-store').default;

interface ProfileStoreShape {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  clear: () => void;
}

let storeInstance: ProfileStoreShape | null = null;

/** Test-only storage seam; production always uses encrypted electron-store. */
export function __setExternalSecretProfileStoreForTests(store: ProfileStoreShape | null): void {
  storeInstance = store;
}

function getStore(): ProfileStoreShape {
  if (storeInstance) return storeInstance;
  storeInstance = new Store({
    name: 'restura-external-secret-profiles',
    encryptionKey: getOrCreateEncryptedKey({
      fileName: '.external-secret-profiles-key',
      storeLabel: 'external secret profile store',
    }),
    clearInvalidConfig: true,
  }) as ProfileStoreShape;
  return storeInstance;
}

function readProfiles(): ExternalSecretProfile[] {
  const parsed = externalSecretProfileListSchema.safeParse(getStore().get('profiles'));
  return parsed.success ? parsed.data : [];
}

function persist(profiles: ExternalSecretProfile[]): void {
  getStore().set('profiles', profiles);
  // Request-time resolution reads this validated main-process snapshot only.
  replaceExternalSecretProfiles(profiles);
}

export function listExternalSecretProfiles(): ExternalSecretProfile[] {
  return readProfiles();
}

export function createExternalSecretProfile(
  input: ExternalSecretProfileInput
): ExternalSecretProfile {
  const profile = { ...input, id: crypto.randomUUID() } as ExternalSecretProfile;
  persist([...readProfiles(), profile]);
  return profile;
}

export function updateExternalSecretProfile(profile: ExternalSecretProfile): void {
  const profiles = readProfiles();
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  if (index < 0) throw new Error('External secret profile was not found');
  profiles[index] = profile;
  persist(profiles);
}

export function deleteExternalSecretProfile(id: string): void {
  persist(readProfiles().filter((profile) => profile.id !== id));
}

export function clearExternalSecretProfiles(): void {
  getStore().clear();
  replaceExternalSecretProfiles([]);
}

export function registerExternalSecretProfileIPC(): void {
  replaceExternalSecretProfiles(readProfiles());
  ipcMain.handle(
    IPC.externalSecrets.list,
    createValidatedHandler(IPC.externalSecrets.list, NoInputSchema, () => ({
      profiles: listExternalSecretProfiles(),
    }))
  );
  ipcMain.handle(
    IPC.externalSecrets.create,
    createValidatedHandler(
      IPC.externalSecrets.create,
      ExternalSecretProfileCreateSchema,
      (input) => ({
        profile: createExternalSecretProfile(input),
      })
    )
  );
  ipcMain.handle(
    IPC.externalSecrets.update,
    createValidatedHandler(
      IPC.externalSecrets.update,
      ExternalSecretProfileUpdateSchema,
      (profile) => {
        updateExternalSecretProfile(profile);
        return { ok: true };
      }
    )
  );
  ipcMain.handle(
    IPC.externalSecrets.delete,
    createValidatedHandler(
      IPC.externalSecrets.delete,
      ExternalSecretProfileDeleteSchema,
      ({ id }) => {
        deleteExternalSecretProfile(id);
        return { ok: true };
      }
    )
  );
  ipcMain.handle(
    IPC.externalSecrets.clear,
    createValidatedHandler(IPC.externalSecrets.clear, NoInputSchema, () => {
      clearExternalSecretProfiles();
      return { ok: true };
    })
  );
}

export function unregisterExternalSecretProfileIPC(): void {
  ipcMain.removeHandler(IPC.externalSecrets.list);
  ipcMain.removeHandler(IPC.externalSecrets.create);
  ipcMain.removeHandler(IPC.externalSecrets.update);
  ipcMain.removeHandler(IPC.externalSecrets.delete);
  ipcMain.removeHandler(IPC.externalSecrets.clear);
}
