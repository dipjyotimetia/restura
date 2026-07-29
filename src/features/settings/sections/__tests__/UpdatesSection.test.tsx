import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpdatesSection } from '../UpdatesSection';

const managedStatus = vi.hoisted(() => ({
  value: {
    state: 'managed',
    source: 'native',
    networkMode: 'pac',
    updatesMode: 'disabled',
    requireProxy: true,
  } as const,
}));

vi.mock('@/lib/shared/platform', () => ({
  isElectron: () => true,
  getElectronAPI: () => ({
    updater: { check: vi.fn() },
  }),
}));

vi.mock('@/components/shared/settings/useReleaseNotes', () => ({
  useReleaseNotes: () => ({
    releases: [],
    selectedId: null,
    setSelectedId: vi.fn(),
    nextPage: null,
    loading: false,
    loadingMore: false,
    error: null,
    reload: vi.fn(),
    loadMore: vi.fn(),
  }),
}));

vi.mock('../../ManagedPolicyContext', () => ({
  useManagedPolicyStatus: () => managedStatus.value,
}));

vi.mock('@/store/useSettingsStore', () => ({
  useSettingsStore: (
    selector: (state: {
      settings: { autoUpdate: { autoDownload: boolean; channel: 'stable' } };
      updateSettings: ReturnType<typeof vi.fn>;
    }) => unknown
  ) =>
    selector({
      settings: { autoUpdate: { autoDownload: true, channel: 'stable' } },
      updateSettings: vi.fn(),
    }),
}));

describe('UpdatesSection managed policy', () => {
  it('disables manual checks when managed updates are disabled', () => {
    render(<UpdatesSection />);

    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
    expect(screen.getByText('Updates are disabled by your administrator.')).toBeInTheDocument();
  });
});
