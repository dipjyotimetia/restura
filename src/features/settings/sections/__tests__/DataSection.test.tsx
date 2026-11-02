import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
const provider = vi.hoisted(() => ({ encrypted: false, throws: false }));
const downloadBlob = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/hooks/useStorageMonitor', () => ({
  useStorageMonitor: () => ({
    status: { level: 'ok', percentage: 0, totalRecords: 0, message: '' },
    checkStorage: vi.fn(async () => undefined),
    formattedUsed: '0',
    formattedAvailable: '0',
  }),
}));
vi.mock('@/lib/shared/dexie-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/dexie-storage')>()),
  exportDexieData: vi.fn(async () => '{}'),
}));
vi.mock('@/lib/shared/file-utils', () => ({ downloadBlob }));
vi.mock('@/lib/shared/keyProvider', () => ({
  getKeyProvider: () => {
    if (provider.throws) throw new Error('not ready');
    return { isEncrypted: () => provider.encrypted };
  },
}));

import { DataSection } from '../DataSection';

async function exportData(): Promise<void> {
  render(<DataSection />);
  await userEvent.click(screen.getByRole('button', { name: /export data/i }));
  await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Data exported'));
}

describe('data backup export', () => {
  beforeEach(() => {
    toastMock.warning.mockClear();
    toastMock.success.mockClear();
    provider.encrypted = false;
    provider.throws = false;
  });

  it('says an unencrypted backup can contain credentials', async () => {
    await exportData();
    expect(downloadBlob).toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [message] = toastMock.warning.mock.calls[0] as [string];
    expect(message).toMatch(/not encrypted/i);
    expect(message).toMatch(/credentials/i);
  });

  it('keeps the plain message when records are encrypted', async () => {
    provider.encrypted = true;
    await exportData();
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it('warns when the storage mode cannot be determined', async () => {
    provider.throws = true;
    await exportData();
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
  });
});
