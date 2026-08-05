import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalSecretProfile } from '@shared/secrets/external-secret-profile';
import type { ElectronAPI } from '../../../../../electron/types/electron-api';
import SecretInput from '../SecretInput';

const platformMock = vi.hoisted(() => ({
  electron: true,
  api: undefined as ElectronAPI | undefined,
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/shared/platform', () => ({
  isElectron: vi.fn(() => platformMock.electron),
  getElectronAPI: vi.fn(() => platformMock.api),
}));

vi.mock('sonner', () => ({ toast: toastMock }));

const awsProfile: ExternalSecretProfile = {
  id: 'profile-aws',
  label: 'Production AWS',
  provider: 'aws-secrets-manager',
  region: 'ap-southeast-2',
  auth: { kind: 'named-profile', profile: 'production' },
};

function createApi() {
  return {
    secrets: {
      list: vi.fn(async () => ({
        ok: true as const,
        handles: [{ id: 'handle-1', label: 'API key', createdAt: 1 }],
      })),
      store: vi.fn(async () => ({ ok: true as const, id: 'stored-handle' })),
    },
    externalSecrets: {
      list: vi.fn(async () => ({ profiles: [awsProfile] })),
    },
  } as unknown as ElectronAPI;
}

describe('SecretInput', () => {
  beforeEach(() => {
    platformMock.electron = true;
    platformMock.api = createApi();
    vi.clearAllMocks();
    // Radix Select uses pointer-capture APIs which jsdom does not provide.
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
  });

  it('keeps web inputs inline-only', async () => {
    platformMock.electron = false;
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<SecretInput value="" onChange={onChange} placeholder="Token" />);

    await user.type(screen.getByPlaceholderText('Token'), 'abc');
    expect(onChange).toHaveBeenCalledWith({ kind: 'inline', value: 'a' });
    expect(screen.queryByRole('button', { name: 'Store' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'External' })).not.toBeInTheDocument();
  });

  it('stores an inline value with its display label', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const api = platformMock.api as ElectronAPI;

    render(<SecretInput value="top-secret" onChange={onChange} storageLabel="Prod API key" />);
    await user.click(screen.getByRole('button', { name: 'Store' }));

    expect(api.secrets.store).toHaveBeenCalledWith({ value: 'top-secret', label: 'Prod API key' });
    expect(onChange).toHaveBeenCalledWith({
      kind: 'handle',
      id: 'stored-handle',
      label: 'Prod API key',
    });
    expect(toastMock.success).toHaveBeenCalledWith('Secret stored securely');
    await waitFor(() => expect(api.secrets.list).toHaveBeenCalled());
  });

  it('reports unavailable and failed secure storage without changing the value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    platformMock.api = undefined;
    const { rerender } = render(<SecretInput value="top-secret" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Store' }));
    expect(toastMock.error).toHaveBeenCalledWith(
      'Secret storage is not available on this platform'
    );

    platformMock.api = createApi();
    (platformMock.api.secrets.store as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'keychain unavailable',
    });
    rerender(<SecretInput value="top-secret" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Store' }));

    expect(toastMock.error).toHaveBeenCalledWith('Failed to store secret: keychain unavailable');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lists and chooses an existing keychain handle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const api = platformMock.api as ElectronAPI;

    render(<SecretInput value="" onChange={onChange} />);
    const handlePicker = screen.getAllByRole('combobox')[0];
    if (!handlePicker) throw new Error('Expected the handle picker');
    await user.click(handlePicker);
    await user.click(await screen.findByRole('option', { name: 'API key' }));

    expect(api.secrets.list).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({ kind: 'handle', id: 'handle-1', label: 'API key' });
  });

  it('replaces stored handles only when the input is enabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const handle = { kind: 'handle' as const, id: 'handle-1', label: 'API key' };
    const { rerender } = render(<SecretInput value={handle} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onChange).toHaveBeenCalledWith({ kind: 'inline', value: '' });

    rerender(<SecretInput value={handle} onChange={onChange} disabled />);
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
  });

  it('creates a masked external reference from a configured cloud profile', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<SecretInput value="" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'External' }));
    const profilePicker = screen.getAllByRole('combobox')[1];
    if (!profilePicker) throw new Error('Expected the external profile picker');
    await user.click(profilePicker);
    await user.click(await screen.findByRole('option', { name: 'Production AWS' }));
    await user.type(screen.getByPlaceholderText('Secret name'), ' service-token ');
    await user.type(screen.getByPlaceholderText('Version / stage (optional)'), ' AWSCURRENT ');
    await user.type(screen.getByPlaceholderText('Display label (optional)'), ' Service token ');
    await user.click(screen.getByRole('button', { name: 'Use external secret' }));

    expect(onChange).toHaveBeenCalledWith({
      kind: 'external',
      provider: 'aws-secrets-manager',
      profileId: 'profile-aws',
      secretId: 'service-token',
      selector: 'AWSCURRENT',
      label: 'Service token',
    });
  });

  it('requires a profile and secret name before creating an external reference', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(<SecretInput value="" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'External' }));
    await user.click(screen.getByRole('button', { name: 'Use external secret' }));

    expect(toastMock.error).toHaveBeenCalledWith('Choose a profile and enter a secret identifier');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('lets users replace an existing external reference', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();

    render(
      <SecretInput
        value={{
          kind: 'external',
          provider: 'google-secret-manager',
          profileId: 'profile-google',
          secretId: 'old-token',
          label: 'Old token',
        }}
        onChange={onChange}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Replace' }));

    expect(await screen.findByPlaceholderText('Secret name')).toBeInTheDocument();
    expect((platformMock.api as ElectronAPI).externalSecrets.list).toHaveBeenCalled();
  });
});
