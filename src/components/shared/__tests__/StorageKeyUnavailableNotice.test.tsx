import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/shared/dexie-storage', () => ({
  STORAGE_KEY_UNAVAILABLE_EVENT: 'restura:storage-key-unavailable',
  isStorageKeyUnavailable: () => false,
}));

import { StorageKeyUnavailableNotice } from '../StorageKeyUnavailableNotice';

describe('StorageKeyUnavailableNotice', () => {
  it('stays hidden until storage reports the key unavailable, then blocks with a reload action', () => {
    render(<StorageKeyUnavailableNotice />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    act(() => {
      window.dispatchEvent(new CustomEvent('restura:storage-key-unavailable'));
    });

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByText('Saved data is locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /cancel|close/i })).toBeNull();
  });
});
