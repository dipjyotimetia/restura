import { importPostmanCollection } from '@shared/collections/postman';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Collection } from '@/types';

const h = vi.hoisted(() => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: h.toast }));

import { EXPORT_MENU_ITEMS } from '../../components/exportMenuItems';
import { exportToPostman, getCollectionExportWarnings } from '../exporters';
import { savePostmanV21Export } from '../postmanV3Export';

function collection(): Collection {
  const http = (name: string, auth: NonNullable<Collection['auth']>) => ({
    id: name,
    name,
    type: 'request' as const,
    request: {
      id: name,
      name,
      type: 'http' as const,
      method: 'GET' as const,
      url: 'https://api.example.com/x',
      headers: [],
      params: [],
      body: { type: 'none' as const },
      auth,
    },
  });
  return {
    id: 'c',
    name: 'Shop API',
    items: [
      http('Digest', { type: 'digest', digest: { username: 'a', password: 'b' } }),
      http('OAuth1', { type: 'oauth1', oauth1: { consumerKey: 'k', consumerSecret: 's' } }),
      http('NTLM', { type: 'ntlm', ntlm: { username: 'a', password: 'b' } }),
      {
        id: 's',
        name: 'Stream',
        type: 'request',
        request: {
          id: 's',
          name: 'Stream',
          type: 'sse',
          url: 'https://x',
          headers: [],
          params: [],
          auth: { type: 'none' },
        },
      },
    ],
  };
}

describe('Postman v2.1 export — renderer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the Export submenu lists Postman v3 first, then v2.1 (Newman), with the new format id', () => {
    expect(EXPORT_MENU_ITEMS.slice(0, 2)).toEqual([
      { format: 'postman-v3', label: 'Postman v3 (folder / zip)' },
      { format: 'postman-v21', label: 'Postman v2.1 (single file · Newman)' },
    ]);
    expect(EXPORT_MENU_ITEMS.map((i) => i.format)).not.toContain('postman');
  });

  it('exportToPostman keeps digest, oauth1 and ntlm auth', () => {
    const again = importPostmanCollection(exportToPostman(collection())).collection;
    expect(again.items.map((i) => (i.request as { auth: { type: string } }).auth.type)).toEqual([
      'digest',
      'oauth1',
      'ntlm',
    ]);
  });

  it('downloads <name>.postman_collection.json and shows the export report', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    expect(savePostmanV21Export(collection())).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
    expect(h.toast.warning).toHaveBeenCalledWith(
      'Exported Shop API.postman_collection.json — 1 item not exported as-is',
      expect.anything()
    );
  });

  it('a failed download is a visible error (with the report when there is one)', () => {
    URL.createObjectURL = vi.fn(() => {
      throw 'blocked';
    });
    expect(savePostmanV21Export(collection())).toBe(false);
    expect(h.toast.error).toHaveBeenLastCalledWith('Postman v2.1 export failed: blocked', {
      description: expect.anything(),
    });
    URL.createObjectURL = vi.fn(() => {
      throw new Error('denied');
    });
    expect(savePostmanV21Export({ id: 'e', name: 'Empty', items: [] })).toBe(false);
    expect(h.toast.error).toHaveBeenLastCalledWith('Postman v2.1 export failed: denied', {});
  });

  it('the export report supersedes the postman export warnings', () => {
    // Only insomnia / opencollection still use the string warnings.
    expect(getCollectionExportWarnings(collection(), 'insomnia')).toEqual([
      'SSE requests are exported as non-runnable stubs',
    ]);
  });
});
