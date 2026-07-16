import { describe, expect, it } from 'vitest';
import { buildContextPackets, renderContextPacket } from '../grounding';

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
      { sourceIds: ['orders-schema'], maxBytes: 256 }
    );

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      sourceId: 'orders-schema',
      kind: 'openapi',
      label: 'Orders API',
      version: '2026-07-16',
      truncated: true,
    });
    expect(
      new TextEncoder().encode(renderContextPacket(packets[0]!)).byteLength
    ).toBeLessThanOrEqual(256);
  });

  it('rejects an unknown selected source instead of silently searching elsewhere', () => {
    expect(() => buildContextPackets([], { sourceIds: ['missing'], maxBytes: 1_024 })).toThrow(
      'unknown grounding source: missing'
    );
  });

  it.each([0, 1.5, Number.NaN])('rejects an invalid byte budget: %s', (maxBytes) => {
    expect(() => buildContextPackets([], { sourceIds: [], maxBytes })).toThrow(
      'grounding maxBytes must be a positive integer'
    );
  });

  it('counts untrusted labels and versions against the evidence budget', () => {
    const [packet] = buildContextPackets(
      [
        {
          id: 'hostile-label',
          kind: 'mcp-catalog',
          label: 'L'.repeat(1_000),
          version: 'V'.repeat(1_000),
          content: 'C'.repeat(1_000),
        },
      ],
      { sourceIds: ['hostile-label'], maxBytes: 256 }
    );
    expect(packet?.truncated).toBe(true);
    expect(new TextEncoder().encode(renderContextPacket(packet!)).byteLength).toBeLessThanOrEqual(
      256
    );
  });

  it('budgets packet wrappers and inter-packet separators in the rendered evidence', () => {
    const packets = buildContextPackets(
      [
        { id: 'one', kind: 'openapi', label: 'One', version: 'v1', content: 'A'.repeat(1_000) },
        { id: 'two', kind: 'graphql', label: 'Two', version: 'v2', content: 'B'.repeat(1_000) },
      ],
      { sourceIds: ['one', 'two'], maxBytes: 256 }
    );

    expect(
      new TextEncoder().encode(packets.map(renderContextPacket).join('\n\n')).byteLength
    ).toBeLessThanOrEqual(256);
    expect(packets.every((packet) => packet.truncated)).toBe(true);
  });

  it('rejects a selected source when its safety framing cannot fit the budget', () => {
    expect(() =>
      buildContextPackets(
        [{ id: 'tiny', kind: 'history', label: 'Tiny', version: 'v1', content: 'data' }],
        { sourceIds: ['tiny'], maxBytes: 1 }
      )
    ).toThrow('too small for selected source evidence framing');
  });

  it('backs up past a split UTF-8 code point before rendering evidence', () => {
    const source = {
      id: 'utf8',
      kind: 'history' as const,
      label: '',
      version: '',
      content: 'a🙂',
    };
    const [emptyPacket] = buildContextPackets([{ ...source, content: '' }], {
      sourceIds: ['utf8'],
      maxBytes: 1_000,
    });
    const framingBytes = new TextEncoder().encode(renderContextPacket(emptyPacket!)).byteLength;

    const [packet] = buildContextPackets([source], {
      sourceIds: ['utf8'],
      // The initial three-byte slice includes only part of the emoji. Decoding
      // it produces U+FFFD (three bytes), so truncation must retry and retain
      // only the preceding ASCII character.
      maxBytes: framingBytes + 3,
    });

    expect(packet?.content).toBe('a');
    expect(new TextEncoder().encode(renderContextPacket(packet!)).byteLength).toBeLessThanOrEqual(
      framingBytes + 3
    );
  });
});
