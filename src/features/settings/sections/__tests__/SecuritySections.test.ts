import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSecretProfile } from '@shared/secrets/external-secret-profile';
import type { ElectronAPI } from '../../../../../electron/types/electron-api';
import {
  ExternalSecretProfiles,
  SecretsSection,
  buildExternalSecretProfileInput,
} from '../SecuritySections';

const platformMock = vi.hoisted(() => ({
  api: undefined as ElectronAPI | undefined,
  electron: true,
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/shared/platform', () => ({
  getElectronAPI: vi.fn(() => platformMock.api),
  isElectron: vi.fn(() => platformMock.electron),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

const awsProfile: ExternalSecretProfile = {
  id: 'profile-aws',
  label: 'Production AWS',
  provider: 'aws-secrets-manager',
  region: 'ap-southeast-2',
  auth: { kind: 'named-profile', profile: 'production' },
};

const googleWorkloadProfile: ExternalSecretProfile = {
  id: 'profile-google',
  label: 'Google workload',
  provider: 'google-secret-manager',
  projectId: 'project-1',
  auth: { kind: 'workload-identity', credentialConfigFile: '/tmp/google-wif.json' },
};

const awsWorkloadProfile: ExternalSecretProfile = {
  id: 'profile-aws-workload',
  label: 'AWS workload',
  provider: 'aws-secrets-manager',
  region: 'ap-southeast-2',
  auth: {
    kind: 'workload-identity',
    roleArn: 'arn:aws:iam::123:role/restura',
    tokenFile: '/tmp/aws-token',
    sessionName: 'restura',
  },
};

const azureWorkloadProfile: ExternalSecretProfile = {
  id: 'profile-azure',
  label: 'Azure workload',
  provider: 'azure-key-vault',
  vaultName: 'team-vault',
  auth: {
    kind: 'workload-identity',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    tokenFile: '/tmp/azure-token',
  },
};

function createApi(profiles: ExternalSecretProfile[] = []) {
  return {
    externalSecrets: {
      list: vi.fn(async () => ({ profiles })),
      create: vi.fn(async () => ({ profile: awsProfile })),
      update: vi.fn(async () => ({ ok: true as const })),
      delete: vi.fn(async () => ({ ok: true as const })),
    },
    secrets: {
      list: vi.fn(async () => ({ ok: true as const, handles: [] })),
      delete: vi.fn(async () => ({ ok: true as const })),
    },
  } as unknown as ElectronAPI;
}

function installRadixDomShims() {
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
  });
}

describe('buildExternalSecretProfileInput', () => {
  beforeEach(() => {
    platformMock.api = createApi();
    platformMock.electron = true;
    vi.clearAllMocks();
    installRadixDomShims();
  });
  it('requires an AWS region', () => {
    expect(
      buildExternalSecretProfileInput('aws-secrets-manager', 'named-profile', { profile: 'prod' })
    ).toBeNull();
  });

  it('builds an AWS named-profile reference with trimmed metadata', () => {
    expect(
      buildExternalSecretProfileInput('aws-secrets-manager', 'named-profile', {
        label: ' Production ',
        region: ' ap-southeast-2 ',
        profile: ' prod ',
      })
    ).toEqual({
      label: 'Production',
      provider: 'aws-secrets-manager',
      region: 'ap-southeast-2',
      auth: { kind: 'named-profile', profile: 'prod' },
    });
  });

  it('builds an AWS workload identity with the optional session name', () => {
    expect(
      buildExternalSecretProfileInput('aws-secrets-manager', 'workload-identity', {
        region: 'ap-southeast-2',
        roleArn: 'arn:aws:iam::123:role/restura',
        tokenFile: '/tmp/token',
        sessionName: ' restura ',
      })
    ).toMatchObject({
      provider: 'aws-secrets-manager',
      auth: { kind: 'workload-identity', sessionName: 'restura' },
    });
  });

  it('omits optional metadata when it is blank', () => {
    expect(
      buildExternalSecretProfileInput('aws-secrets-manager', 'workload-identity', {
        region: 'ap-southeast-2',
        roleArn: 'arn:aws:iam::123:role/restura',
        tokenFile: '/tmp/token',
      })
    ).toEqual({
      provider: 'aws-secrets-manager',
      region: 'ap-southeast-2',
      auth: {
        kind: 'workload-identity',
        roleArn: 'arn:aws:iam::123:role/restura',
        tokenFile: '/tmp/token',
      },
    });
    expect(
      buildExternalSecretProfileInput('azure-key-vault', 'named-profile', {
        vaultName: 'team-vault',
      })
    ).toEqual({
      provider: 'azure-key-vault',
      vaultName: 'team-vault',
      auth: { kind: 'named-profile' },
    });
  });

  it.each(['named-profile', 'workload-identity'] as const)(
    'builds Google %s configuration from the credential config path',
    (kind) => {
      expect(
        buildExternalSecretProfileInput('google-secret-manager', kind, {
          projectId: ' project-1 ',
          credentialConfigFile: ' /tmp/google.json ',
        })
      ).toEqual({
        provider: 'google-secret-manager',
        projectId: 'project-1',
        auth: { kind, credentialConfigFile: '/tmp/google.json' },
      });
    }
  );

  it('builds Azure named-profile configuration with an optional subscription', () => {
    expect(
      buildExternalSecretProfileInput('azure-key-vault', 'named-profile', {
        vaultName: 'team-vault',
        subscription: 'sub-1',
      })
    ).toEqual({
      provider: 'azure-key-vault',
      vaultName: 'team-vault',
      auth: { kind: 'named-profile', subscription: 'sub-1' },
    });
  });

  it('builds Azure workload identity configuration', () => {
    expect(
      buildExternalSecretProfileInput('azure-key-vault', 'workload-identity', {
        vaultName: 'team-vault',
        tenantId: 'tenant',
        clientId: 'client',
        tokenFile: '/tmp/token',
      })
    ).toEqual({
      provider: 'azure-key-vault',
      vaultName: 'team-vault',
      auth: {
        kind: 'workload-identity',
        tenantId: 'tenant',
        clientId: 'client',
        tokenFile: '/tmp/token',
      },
    });
  });
});

describe('ExternalSecretProfiles', () => {
  beforeEach(() => {
    platformMock.api = createApi();
    platformMock.electron = true;
    vi.clearAllMocks();
    installRadixDomShims();
  });

  it('requires the visible provider fields before adding a profile', async () => {
    const user = userEvent.setup();
    render(createElement(ExternalSecretProfiles));

    await user.click(screen.getByRole('button', { name: 'Add profile' }));

    expect(toastMock.error).toHaveBeenCalledWith('Complete the required profile fields');
    expect((platformMock.api as ElectronAPI).externalSecrets.create).not.toHaveBeenCalled();
  });

  it('creates an AWS profile and refreshes the persisted profile list', async () => {
    const user = userEvent.setup();
    const api = platformMock.api as ElectronAPI;
    render(createElement(ExternalSecretProfiles));

    await user.type(screen.getByPlaceholderText('Profile label'), ' Production ');
    await user.type(screen.getByPlaceholderText('AWS region *'), ' ap-southeast-2 ');
    await user.type(screen.getByPlaceholderText('AWS profile name *'), ' production ');
    await user.click(screen.getByRole('button', { name: 'Add profile' }));

    await waitFor(() =>
      expect(api.externalSecrets.create).toHaveBeenCalledWith({
        provider: 'aws-secrets-manager',
        label: 'Production',
        region: 'ap-southeast-2',
        auth: { kind: 'named-profile', profile: 'production' },
      })
    );
    expect(toastMock.success).toHaveBeenCalledWith('External profile added');
    expect(api.externalSecrets.list).toHaveBeenCalledTimes(2);
  });

  it('edits and deletes a persisted profile through the Electron API', async () => {
    const user = userEvent.setup();
    platformMock.api = createApi([awsProfile]);
    const api = platformMock.api as ElectronAPI;
    render(createElement(ExternalSecretProfiles));

    expect(await screen.findByText('Production AWS')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByPlaceholderText('AWS profile name *'));
    await user.type(screen.getByPlaceholderText('AWS profile name *'), ' staging ');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      expect(api.externalSecrets.update).toHaveBeenCalledWith({
        id: 'profile-aws',
        provider: 'aws-secrets-manager',
        label: 'Production AWS',
        region: 'ap-southeast-2',
        auth: { kind: 'named-profile', profile: 'staging' },
      })
    );
    expect(toastMock.success).toHaveBeenCalledWith('External profile updated');

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.externalSecrets.delete).toHaveBeenCalledWith('profile-aws'));
    expect(toastMock.success).toHaveBeenCalledWith('External profile deleted');
  });

  it('loads a Google workload identity profile into its provider-specific editor', async () => {
    const user = userEvent.setup();
    platformMock.api = createApi([googleWorkloadProfile]);
    render(createElement(ExternalSecretProfiles));

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByPlaceholderText('Google project ID *')).toHaveValue('project-1');
    expect(screen.getByPlaceholderText('Google credential config path *')).toHaveValue(
      '/tmp/google-wif.json'
    );
    expect(screen.queryByPlaceholderText('AWS region *')).not.toBeInTheDocument();
  });

  it('loads an AWS workload identity profile into its provider-specific editor', async () => {
    const user = userEvent.setup();
    platformMock.api = createApi([awsWorkloadProfile]);
    render(createElement(ExternalSecretProfiles));

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByPlaceholderText('AWS region *')).toHaveValue('ap-southeast-2');
    expect(screen.getByPlaceholderText('AWS role ARN *')).toHaveValue(
      'arn:aws:iam::123:role/restura'
    );
    expect(screen.getByPlaceholderText('Web identity token file *')).toHaveValue('/tmp/aws-token');
    expect(screen.getByPlaceholderText('Session name')).toHaveValue('restura');
  });

  it('loads an Azure workload identity profile into its provider-specific editor', async () => {
    const user = userEvent.setup();
    platformMock.api = createApi([azureWorkloadProfile]);
    render(createElement(ExternalSecretProfiles));

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByPlaceholderText('Azure vault name *')).toHaveValue('team-vault');
    expect(screen.getByPlaceholderText('Azure tenant ID *')).toHaveValue('tenant-1');
    expect(screen.getByPlaceholderText('Azure client ID *')).toHaveValue('client-1');
    expect(screen.getByPlaceholderText('Federated token file *')).toHaveValue('/tmp/azure-token');
    expect(screen.queryByPlaceholderText('AWS profile name *')).not.toBeInTheDocument();
  });
});

describe('SecretsSection', () => {
  beforeEach(() => {
    platformMock.api = createApi();
    platformMock.electron = true;
    vi.clearAllMocks();
    installRadixDomShims();
  });

  it('uses the desktop-only explanation in the web build', () => {
    platformMock.electron = false;
    render(createElement(SecretsSection));

    expect(screen.getByText('Desktop only')).toBeInTheDocument();
  });

  it('lists stored handles and deletes the selected handle', async () => {
    const user = userEvent.setup();
    const api = createApi();
    (api.secrets.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      handles: [
        { id: 'handle-labelled', label: 'Production token', scope: 'auth', createdAt: 1 },
        { id: 'abcdefghijk', createdAt: 2 },
      ],
    });
    platformMock.api = api;

    render(createElement(SecretsSection));
    expect(await screen.findByText('Production token')).toBeInTheDocument();
    expect(screen.getByText('abcdefgh…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete handle Production token' }));

    await waitFor(() => expect(api.secrets.delete).toHaveBeenCalledWith('handle-labelled'));
    expect(toastMock.success).toHaveBeenCalledWith('Secret deleted');
  });

  it('reports failed handle listing and deletion', async () => {
    const user = userEvent.setup();
    const api = createApi();
    (api.secrets.list as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, handles: [{ id: 'handle-1', createdAt: 1 }] })
      .mockResolvedValueOnce({ ok: false, error: 'keychain unavailable' });
    (api.secrets.delete as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'access denied',
    });
    platformMock.api = api;

    render(createElement(SecretsSection));
    expect(
      await screen.findByRole('button', { name: 'Delete handle handle-1' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete handle handle-1' }));

    expect(toastMock.error).toHaveBeenCalledWith('Failed to delete: access denied');
  });
});
