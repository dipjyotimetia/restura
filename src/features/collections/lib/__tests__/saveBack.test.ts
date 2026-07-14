import { beforeEach, describe, expect, it } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { HttpRequest } from '@/types';
import { saveTabBackToCollection } from '../saveBack';

const request: HttpRequest = {
  id: 'request',
  name: 'Detached',
  type: 'http',
  method: 'GET',
  url: 'https://example.com',
  headers: [],
  params: [],
  body: { type: 'none' },
  auth: { type: 'none' },
};

describe('saveTabBackToCollection', () => {
  beforeEach(() => useCollectionStore.setState({ collections: [] }));

  it('fails closed when the owning collection item was deleted', () => {
    expect(saveTabBackToCollection(request, 'missing-item')).toBe(false);
  });
});
