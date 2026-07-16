import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { resolveDesktopGrounding } from '../agentGrounding';

describe('resolveDesktopGrounding', () => {
  beforeEach(() => {
    useCollectionStore.setState({
      collections: [
        {
          id: 'orders',
          name: 'Orders',
          description: 'collection-description-secret',
          items: [
            {
              id: 'item-1',
              name: 'Get orders',
              type: 'request',
              request: {
                id: 'request-1',
                name: 'Get orders',
                type: 'http',
                method: 'GET',
                url: 'https://alice:secret@example.test/orders?token=signed',
                headers: [
                  { id: 'auth', key: 'Authorization', value: 'Bearer private', enabled: true },
                ],
                params: [],
                body: { type: 'none' },
                auth: { type: 'none' },
              },
            },
          ],
        },
      ],
      activeCollectionId: 'orders',
    });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  afterEach(() => {
    useCollectionStore.setState({ collections: [], activeCollectionId: null });
    useMcpStore.setState({ connections: {}, activeConnectionId: null });
  });

  it('grounds only selected sanitized collection metadata', async () => {
    const packets = await resolveDesktopGrounding({ sourceIds: ['orders'], maxBytes: 10_000 });

    expect(packets).toEqual([
      expect.objectContaining({ sourceId: 'orders', kind: 'collection', label: 'Orders' }),
    ]);
    const text = packets[0]!.content;
    expect(text).toContain('GET https://example.test/orders?token=REDACTED');
    expect(text).not.toMatch(
      /alice|secret|signed|Authorization|private|collection-description-secret/
    );
  });

  it('rejects a source the user did not make available on desktop', async () => {
    await expect(
      resolveDesktopGrounding({ sourceIds: ['not-a-source'], maxBytes: 1_000 })
    ).rejects.toThrow('unknown grounding source');
  });
});
