import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedPolicyBanner, ManagedPolicyProvider } from '../ManagedPolicyContext';

const policyStatus = vi.hoisted(() => ({
  get: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@/lib/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/platform')>()),
  isElectron: () => true,
  getElectronAPI: () => ({
    security: { getManagedPolicyStatus: policyStatus.get },
  }),
}));

function renderBanner(active = true) {
  return render(
    <ManagedPolicyProvider active={active}>
      <ManagedPolicyBanner />
    </ManagedPolicyProvider>
  );
}

describe('ManagedPolicyContext', () => {
  beforeEach(() => {
    policyStatus.get.mockReset();
  });

  it('shows redacted managed network and update status', async () => {
    policyStatus.get.mockResolvedValue({
      state: 'managed',
      source: 'native',
      networkMode: 'pac',
      updatesMode: 'notify',
      requireProxy: true,
      minimumVersion: '2.0.0',
      upgradeRequired: true,
    });

    renderBanner();

    expect(await screen.findByText('Managed by your organization')).toBeInTheDocument();
    expect(screen.getByText(/pac network · notify updates · version 2.0.0/)).toBeInTheDocument();
  });

  it('shows an administrator-facing invalid-policy diagnostic', async () => {
    policyStatus.get.mockResolvedValue({
      state: 'invalid',
      source: 'machine-file',
      message: 'Managed enterprise policy could not be applied. Contact your administrator.',
    });

    renderBanner();

    expect(
      await screen.findByText('Enterprise policy needs administrator attention')
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Contact your administrator');
  });

  it('renders no banner when policy lookup fails', async () => {
    policyStatus.get.mockRejectedValue(new Error('bridge unavailable'));

    renderBanner();

    await waitFor(() => expect(policyStatus.get).toHaveBeenCalledOnce());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not query policy while the settings surface is inactive', () => {
    renderBanner(false);

    expect(policyStatus.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
