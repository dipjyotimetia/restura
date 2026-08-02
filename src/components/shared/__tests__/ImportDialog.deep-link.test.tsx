import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';

const platform = vi.hoisted(() => ({
  getElectronAPI: vi.fn(),
  isElectron: vi.fn(() => false),
}));

vi.mock('@/lib/shared/platform', () => platform);

import ImportDialog from '../ImportDialog';

const SOURCE = JSON.stringify({
  info: {
    name: 'Deep link preview',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [],
});

describe('ImportDialog deep links', () => {
  beforeEach(() => {
    useCollectionStore.setState({ collections: [] });
    platform.getElectronAPI.mockReset();
  });

  it('downloads only a preview until the import is confirmed', async () => {
    const fetchImport = vi.fn().mockResolvedValue({ ok: true, text: SOURCE });
    platform.getElectronAPI.mockReturnValue({ deepLinks: { fetchImport } });
    const user = userEvent.setup();
    render(
      <ImportDialog
        open
        onOpenChange={vi.fn()}
        deepLinkSource={{ url: 'https://example.com/collection.json', format: 'postman' }}
      />
    );

    await user.click(screen.getByRole('button', { name: /download preview/i }));
    expect(await screen.findByRole('region', { name: 'Import preview' })).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /confirm import/i }));
    expect(useCollectionStore.getState().collections).toHaveLength(1);
  });

  it('keeps a failed deep-link download out of the store', async () => {
    platform.getElectronAPI.mockReturnValue({
      deepLinks: {
        fetchImport: vi.fn().mockResolvedValue({ ok: false, error: 'remote source blocked' }),
      },
    });
    const user = userEvent.setup();
    render(
      <ImportDialog
        open
        onOpenChange={vi.fn()}
        deepLinkSource={{ url: 'https://example.com/collection.json' }}
      />
    );

    await user.click(screen.getByRole('button', { name: /download preview/i }));
    expect(await screen.findByText('remote source blocked')).toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });

  it('does not invoke a deep-link download while Remote URL is selected', async () => {
    const fetchImport = vi.fn();
    platform.getElectronAPI.mockReturnValue({ deepLinks: { fetchImport } });
    const user = userEvent.setup();
    render(
      <ImportDialog
        open
        onOpenChange={vi.fn()}
        deepLinkSource={{ url: 'https://example.com/collection.json' }}
      />
    );

    await user.click(screen.getByRole('button', { name: /^Remote URL/ }));
    await user.click(screen.getByRole('button', { name: /download preview/i }));
    expect(fetchImport).not.toHaveBeenCalled();
  });

  it('leaves a deep link pending when the Electron import bridge is unavailable', async () => {
    platform.getElectronAPI.mockReturnValue(undefined);
    const user = userEvent.setup();
    render(
      <ImportDialog
        open
        onOpenChange={vi.fn()}
        deepLinkSource={{ url: 'https://example.com/request.http', format: 'http' }}
      />
    );

    await user.click(screen.getByRole('button', { name: /download preview/i }));
    expect(screen.queryByRole('region', { name: 'Import preview' })).not.toBeInTheDocument();
    expect(useCollectionStore.getState().collections).toHaveLength(0);
  });
});
