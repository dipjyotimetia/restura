import { describe, expect, it } from 'vitest';
import { buildContextPackets } from '../grounding';

describe('buildContextPackets', () => {
  it('uses only explicitly selected sources and truncates deterministically to the byte budget', () => {
    const packets = buildContextPackets(
      [
        {
          id: 'orders-schema',
          kind: 'openapi',
          label: 'Orders API',
          version: '2026-07-16',
          content: 'GET /orders/{id}\n'.repeat(20),
        },
        {
          id: 'hidden-history',
          kind: 'history',
          label: 'Unselected history',
          version: '1',
          content: 'must never be supplied',
        },
      ],
      { sourceIds: ['orders-schema'], maxBytes: 64 }
    );

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      sourceId: 'orders-schema',
      kind: 'openapi',
      label: 'Orders API',
      version: '2026-07-16',
      truncated: true,
    });
    expect(new TextEncoder().encode(packets[0]?.content).byteLength).toBeLessThanOrEqual(64);
  });

  it('rejects an unknown selected source instead of silently searching elsewhere', () => {
    expect(() => buildContextPackets([], { sourceIds: ['missing'], maxBytes: 1_024 })).toThrow(
      'unknown grounding source: missing'
    );
  });
});
