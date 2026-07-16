import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeManifest } from '../../commands/agentRuntime.js';
import { resolveCliGrounding } from '../agentGrounding.js';

const runtime: AgentRuntimeManifest = {
  schemaVersion: 1,
  sources: [{ id: 'orders', kind: 'collection', path: './orders', requestIds: ['get-orders'] }],
};

describe('resolveCliGrounding', () => {
  it('uses only selected manifest collection metadata and removes URL secrets', async () => {
    const loadCollection = vi.fn().mockResolvedValue({
      meta: { name: 'Orders', description: 'collection-description-secret' },
      requests: [
        {
          relativePath: 'Get orders',
          type: 'http',
          request: {
            method: 'GET',
            url: 'https://alice:secret@example.test/orders?token=signed',
          },
        },
      ],
    });
    const packets = await resolveCliGrounding(
      { sourceIds: ['orders'], maxBytes: 10_000 },
      runtime,
      { environment: {}, allowLocalhost: false, timeoutMs: 5_000 },
      { loadCollection }
    );

    expect(loadCollection).toHaveBeenCalledWith('./orders');
    expect(packets[0]).toMatchObject({ sourceId: 'orders', kind: 'collection' });
    expect(packets[0]?.content).toContain('https://example.test/orders?token=REDACTED');
    expect(packets[0]?.content).not.toMatch(/alice|secret|signed|collection-description-secret/);
  });

  it('rejects grounding that is not available in the runtime manifest', async () => {
    await expect(
      resolveCliGrounding(
        { sourceIds: ['missing'], maxBytes: 100 },
        runtime,
        { environment: {}, allowLocalhost: false, timeoutMs: 5_000 },
        { loadCollection: vi.fn() }
      )
    ).rejects.toThrow('not listed in the runtime manifest');
  });
});
