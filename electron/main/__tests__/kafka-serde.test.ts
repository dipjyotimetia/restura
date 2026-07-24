// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  computeGroupLag,
  decodeDisplayField,
  decodeField,
  decodeWirePayload,
  encodeSchemaField,
  flattenConfigDescriptions,
  flattenGroup,
  isConfluentEncoded,
  parseSchemaJson,
  topicWatermarks,
  valueToString,
} from '../handlers/kafka-serde';

describe('valueToString', () => {
  it('passes a plain string through unchanged (string consumer path)', () => {
    expect(valueToString('hello')).toBe('hello');
    expect(valueToString('')).toBe('');
  });

  it('JSON-serializes a registry-decoded object (Avro/Protobuf/JSON path)', () => {
    expect(valueToString({ id: 1, name: 'a' })).toBe('{"id":1,"name":"a"}');
    expect(valueToString([1, 2, 3])).toBe('[1,2,3]');
  });

  it('decodes a Buffer / Uint8Array to utf-8 text', () => {
    expect(valueToString(Buffer.from('raw bytes'))).toBe('raw bytes');
    expect(valueToString(new TextEncoder().encode('uint8'))).toBe('uint8');
  });

  it('maps null / undefined to an empty string', () => {
    expect(valueToString(null)).toBe('');
    expect(valueToString(undefined)).toBe('');
  });

  it('stringifies primitives that are not strings', () => {
    expect(valueToString(42)).toBe('42');
    expect(valueToString(true)).toBe('true');
  });
});

describe('parseSchemaJson', () => {
  it('parses a JSON object', () => {
    expect(parseSchemaJson('{"id":1,"name":"a"}')).toEqual({ value: { id: 1, name: 'a' } });
  });

  it('parses a JSON scalar (e.g. an Avro string schema)', () => {
    expect(parseSchemaJson('"hello"')).toEqual({ value: 'hello' });
  });

  it('errors on a non-JSON value (default field label)', () => {
    expect(parseSchemaJson('not json')).toEqual({
      error: 'Schema-encoded value must be valid JSON.',
    });
  });

  it('shapes the error message by field', () => {
    expect(parseSchemaJson('not json', 'key')).toEqual({
      error: 'Schema-encoded key must be valid JSON.',
    });
  });
});

describe('isConfluentEncoded', () => {
  it('is true for the Confluent wire framing (magic byte 0x00 + 4-byte id)', () => {
    // 0x00 magic + schema id 2 + a byte of payload.
    expect(isConfluentEncoded(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x02, 0x42]))).toBe(true);
  });

  it('is false for plain UTF-8 bytes', () => {
    expect(isConfluentEncoded(Buffer.from('hello', 'utf-8'))).toBe(false);
  });

  it('is false for a buffer shorter than the 5-byte header', () => {
    expect(isConfluentEncoded(Buffer.from([0x00, 0x00]))).toBe(false);
  });
});

describe('encodeSchemaField', () => {
  const okRegistry = {
    encode: async (id: number, payload: unknown) =>
      Buffer.from(`enc:${id}:${JSON.stringify(payload)}`),
  };

  it('parses JSON and encodes with the schema id', async () => {
    const r = await encodeSchemaField(okRegistry, 7, '{"id":1}', 'value');
    expect(r).toEqual({ value: Buffer.from('enc:7:{"id":1}') });
  });

  it('errors on non-JSON input (field-shaped message)', async () => {
    expect(await encodeSchemaField(okRegistry, 7, 'nope', 'key')).toEqual({
      error: 'Schema-encoded key must be valid JSON.',
    });
  });

  it('wraps a registry encode failure with the field label', async () => {
    const badRegistry = {
      encode: async () => {
        throw new Error('schema 9 not found');
      },
    };
    expect(await encodeSchemaField(badRegistry, 9, '{"a":1}', 'value')).toEqual({
      error: 'Value schema encode failed: schema 9 not found',
    });
  });
});

describe('decodeField', () => {
  const registry = { decode: async (_buf: Buffer) => ({ decoded: true }) };

  it('registry-decodes a Confluent-framed buffer to its JSON string', async () => {
    const framed = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x42]);
    expect(await decodeField(registry, framed)).toBe('{"decoded":true}');
  });

  it('reads a plain buffer as UTF-8 (no registry)', async () => {
    expect(await decodeField(undefined, Buffer.from('hello', 'utf-8'))).toBe('hello');
  });

  it('passes a non-framed buffer through as text even with a registry', async () => {
    expect(await decodeField(registry, Buffer.from('plain', 'utf-8'))).toBe('plain');
  });

  it('falls back to raw text when decode throws (schema missing)', async () => {
    const failing = {
      decode: async () => {
        throw new Error('schema missing');
      },
    };
    const framed = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x68, 0x69]);
    // Falls back to the UTF-8 reading of the framed bytes (best-effort display).
    expect(await decodeField(failing, framed)).toBe(framed.toString('utf-8'));
  });
});

describe('binary payload serde', () => {
  it('decodes a Base64 produce value to the original arbitrary bytes', () => {
    expect(decodeWirePayload('/4AB', 'base64', 'value')).toEqual({
      value: Buffer.from([0xff, 0x80, 0x01]),
    });
  });

  it('rejects non-canonical Base64 rather than silently changing the payload', () => {
    expect(decodeWirePayload('not base64', 'base64', 'value')).toEqual({
      error: 'Binary value must be canonical Base64.',
    });
  });

  it('returns a Base64 display payload for non-UTF-8 consumed bytes', async () => {
    expect(await decodeDisplayField(undefined, Buffer.from([0xff, 0x80, 0x01]))).toEqual({
      value: '/4AB',
      encoding: 'base64',
    });
  });

  it('retains UTF-8 display text for ordinary consumed bytes', async () => {
    expect(await decodeDisplayField(undefined, Buffer.from('hello', 'utf-8'))).toEqual({
      value: 'hello',
      encoding: 'utf8',
    });
  });
});

// ---------------------------------------------------------------------------
// Admin / observability serde (issue #257)
// ---------------------------------------------------------------------------

describe('topicWatermarks', () => {
  it('pairs earliest (low) + latest (high) by partition with count = high - low', () => {
    const earliest = [
      { partitionIndex: 0, offset: 10n },
      { partitionIndex: 1, offset: 0n },
    ];
    const latest = [
      { partitionIndex: 0, offset: 100n },
      { partitionIndex: 1, offset: 5n },
    ];
    expect(topicWatermarks(earliest, latest)).toEqual([
      { partition: 0, low: '10', high: '100', count: '90' },
      { partition: 1, low: '0', high: '5', count: '5' },
    ]);
  });

  it('defaults low to 0 when a partition is missing from the earliest set', () => {
    expect(topicWatermarks([], [{ partitionIndex: 2, offset: 7n }])).toEqual([
      { partition: 2, low: '0', high: '7', count: '7' },
    ]);
  });

  it('clamps a negative count to 0 and sorts by partition', () => {
    const earliest = [
      { partitionIndex: 1, offset: 0n },
      { partitionIndex: 0, offset: 50n },
    ];
    const latest = [
      { partitionIndex: 1, offset: 9n },
      { partitionIndex: 0, offset: 40n }, // high < low → count clamps to 0
    ];
    expect(topicWatermarks(earliest, latest)).toEqual([
      { partition: 0, low: '50', high: '40', count: '0' },
      { partition: 1, low: '0', high: '9', count: '9' },
    ]);
  });

  it('keeps large offsets exact past 2^53 (string, not number)', () => {
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    expect(
      topicWatermarks([{ partitionIndex: 0, offset: 1n }], [{ partitionIndex: 0, offset: big }])
    ).toEqual([{ partition: 0, low: '1', high: '9007199254740993', count: '9007199254740992' }]);
  });
});

describe('flattenConfigDescriptions', () => {
  it('flattens the nested configs array and sorts by name', () => {
    const out = flattenConfigDescriptions([
      {
        configs: [
          {
            name: 'retention.ms',
            value: '604800000',
            configSource: 1,
            isSensitive: false,
            readOnly: false,
          },
          {
            name: 'cleanup.policy',
            value: 'delete',
            configSource: 5,
            isSensitive: false,
            readOnly: false,
          },
        ],
      },
    ]);
    expect(out.map((c) => c.name)).toEqual(['cleanup.policy', 'retention.ms']);
  });

  it('marks default-source (5) configs as isDefault and labels the source', () => {
    expect(
      flattenConfigDescriptions([
        {
          configs: [{ name: 'a', value: 'x', configSource: 5, isSensitive: false, readOnly: true }],
        },
      ])
    ).toEqual([
      {
        name: 'a',
        value: 'x',
        source: 'default',
        isDefault: true,
        isSensitive: false,
        readOnly: true,
      },
    ]);
  });

  it('flags topic-source (1) configs as not default', () => {
    expect(
      flattenConfigDescriptions([
        {
          configs: [
            { name: 'b', value: 'y', configSource: 1, isSensitive: false, readOnly: false },
          ],
        },
      ])
    ).toEqual([
      {
        name: 'b',
        value: 'y',
        source: 'topic',
        isDefault: false,
        isSensitive: false,
        readOnly: false,
      },
    ]);
  });

  it('coerces an undefined config value to null', () => {
    expect(
      flattenConfigDescriptions([
        {
          configs: [
            { name: 'c', value: undefined, configSource: 1, isSensitive: false, readOnly: false },
          ],
        },
      ])
    ).toEqual([
      {
        name: 'c',
        value: null,
        source: 'topic',
        isDefault: false,
        isSensitive: false,
        readOnly: false,
      },
    ]);
  });

  it('nulls a sensitive value so plaintext never crosses IPC', () => {
    expect(
      flattenConfigDescriptions([
        {
          configs: [
            {
              name: 'sasl.jaas',
              value: 'secret',
              configSource: 1,
              isSensitive: true,
              readOnly: false,
            },
          ],
        },
      ])
    ).toEqual([
      {
        name: 'sasl.jaas',
        value: null,
        source: 'topic',
        isDefault: false,
        isSensitive: true,
        readOnly: false,
      },
    ]);
  });
});

describe('flattenGroup', () => {
  it('recurses the members Map and each member assignments Map into arrays', () => {
    const group = {
      id: 'g1',
      state: 'STABLE',
      protocol: 'roundrobin',
      protocolType: 'consumer',
      members: new Map([
        [
          'm1',
          {
            id: 'm1',
            clientId: 'c1',
            clientHost: '/10.0.0.1',
            assignments: new Map([['topicA', { topic: 'topicA', partitions: [0, 1] }]]),
          },
        ],
      ]),
    };
    expect(flattenGroup(group)).toEqual({
      id: 'g1',
      state: 'STABLE',
      protocol: 'roundrobin',
      protocolType: 'consumer',
      members: [
        {
          memberId: 'm1',
          clientId: 'c1',
          clientHost: '/10.0.0.1',
          assignments: [{ topic: 'topicA', partitions: [0, 1] }],
        },
      ],
    });
  });

  it('handles a member with no assignments and an empty members map', () => {
    const group = {
      id: 'g2',
      state: 'EMPTY',
      protocolType: '',
      members: new Map([['m', { id: 'm', clientId: 'c', clientHost: 'h' }]]),
    };
    const flat = flattenGroup(group);
    expect(flat.protocol).toBe('');
    expect(flat.members).toEqual([
      { memberId: 'm', clientId: 'c', clientHost: 'h', assignments: [] },
    ]);
    expect(
      flattenGroup({ id: 'g3', state: 'DEAD', protocolType: '', members: new Map() }).members
    ).toEqual([]);
  });
});

describe('computeGroupLag', () => {
  const latest = [
    {
      name: 'orders',
      partitions: [
        { partitionIndex: 0, offset: 1300n },
        { partitionIndex: 1, offset: 980n },
      ],
    },
  ];

  it('computes lag = logEnd - committed per partition', () => {
    const committed = [
      {
        name: 'orders',
        partitions: [
          { partitionIndex: 0, committedOffset: 1240n },
          { partitionIndex: 1, committedOffset: 980n },
        ],
      },
    ];
    expect(computeGroupLag(committed, latest)).toEqual([
      { topic: 'orders', partition: 0, committed: '1240', logEnd: '1300', lag: '60' },
      { topic: 'orders', partition: 1, committed: '980', logEnd: '980', lag: '0' }, // committed == latest → 0
    ]);
  });

  it('reports committed=null and lag=full logEnd when there is no commit (-1)', () => {
    const committed = [
      { name: 'orders', partitions: [{ partitionIndex: 0, committedOffset: -1n }] },
    ];
    expect(computeGroupLag(committed, latest)).toEqual([
      { topic: 'orders', partition: 0, committed: null, logEnd: '1300', lag: '1300' },
    ]);
  });

  it('clamps lag to 0 when committed exceeds logEnd (data deleted under offset)', () => {
    const committed = [
      { name: 'orders', partitions: [{ partitionIndex: 1, committedOffset: 2000n }] },
    ];
    expect(computeGroupLag(committed, latest)).toEqual([
      { topic: 'orders', partition: 1, committed: '2000', logEnd: '980', lag: '0' },
    ]);
  });

  it('treats a missing latest watermark as logEnd 0', () => {
    const committed = [{ name: 'gone', partitions: [{ partitionIndex: 0, committedOffset: 5n }] }];
    expect(computeGroupLag(committed, latest)).toEqual([
      { topic: 'gone', partition: 0, committed: '5', logEnd: '0', lag: '0' },
    ]);
  });
});
