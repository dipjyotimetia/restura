import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '@/types';

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { saveCollectionToDirectory } from '../useFileCollectionStore';

const collection = { id: 'c1', name: 'Team', items: [] } as Collection;

function install(result: unknown): void {
  (window as unknown as { electron: unknown }).electron = {
    collections: { saveToDirectory: vi.fn(async () => result) },
  };
}

describe('saveCollectionToDirectory notices', () => {
  beforeEach(() => {
    toastMock.warning.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { electron?: unknown }).electron;
  });

  it('warns by item name when an address was saved blank', async () => {
    install({
      success: true,
      redactions: {
        credentialsRemovedFrom: ['Orders', '<collection>'],
        addressesBlankedIn: ['Orders'],
      },
    });
    const result = await saveCollectionToDirectory(collection, '/d');
    expect(result.success).toBe(true);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [message, options] = toastMock.warning.mock.calls[0] as [string, { id: string }];
    expect(message).toContain('Orders');
    expect(message).toMatch(/blank/i);
    expect(message).toMatch(/re-enter/i);
    expect(message).toContain('the collection');
    expect(message).not.toContain('<collection>');
    expect(options.id).toContain('c1');
  });

  it('warns when credentials alone were left out', async () => {
    install({
      success: true,
      redactions: { credentialsRemovedFrom: ['Login'], addressesBlankedIn: [] },
    });
    await saveCollectionToDirectory(collection, '/d');
    const [message] = toastMock.warning.mock.calls[0] as [string];
    expect(message).toContain('Login');
    expect(message).not.toMatch(/blank/i);
  });

  it('shortens a long list of names', async () => {
    install({
      success: true,
      redactions: {
        credentialsRemovedFrom: ['a', 'b', 'c', 'd', 'e'],
        addressesBlankedIn: [],
      },
    });
    await saveCollectionToDirectory(collection, '/d');
    const [message] = toastMock.warning.mock.calls[0] as [string];
    expect(message).toContain('a, b, c and 2 more');
  });

  it('stays quiet for a result without the field, and for a failed save', async () => {
    install({ success: true });
    await expect(saveCollectionToDirectory(collection, '/d')).resolves.toEqual({ success: true });
    install({ success: false, error: 'nope' });
    await saveCollectionToDirectory(collection, '/d');
    expect(toastMock.warning).not.toHaveBeenCalled();
  });
});
