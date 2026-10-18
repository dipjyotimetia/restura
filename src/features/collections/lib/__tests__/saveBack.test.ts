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

  it('refuses to overwrite a Kafka preset with the tab placeholder (#984)', () => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'c',
          name: 'C',
          items: [
            {
              id: 'folder',
              name: 'F',
              type: 'folder',
              items: [
                {
                  id: 'preset',
                  name: 'Orders',
                  type: 'request',
                  request: {
                    id: 'k',
                    name: 'Orders',
                    type: 'kafka',
                    connection: {
                      bootstrapBrokers: [],
                      clientId: '',
                      securityProtocol: 'PLAINTEXT',
                      acks: 1,
                      compression: 'none',
                      idempotent: false,
                    },
                    produce: {
                      topic: '',
                      key: '',
                      keyEncoding: 'utf8',
                      value: '',
                      valueEncoding: 'utf8',
                      headers: [],
                    },
                    consume: { groupId: '', topics: [], mode: 'committed' },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(saveTabBackToCollection(request, 'preset')).toBe(false);
    const saved = useCollectionStore.getState().collections[0]?.items[0]?.items?.[0];
    expect(saved?.request?.type).toBe('kafka');
  });

  it('fails closed when the owning collection item was deleted', () => {
    expect(saveTabBackToCollection(request, 'missing-item')).toBe(false);
  });
});
