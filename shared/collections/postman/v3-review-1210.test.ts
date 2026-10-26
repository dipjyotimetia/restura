import { describe, expect, it } from 'vitest';
import type { CollectionItem, KafkaRequest, MqttRequest } from '../../types';
import { importPostmanCollection } from './index';
import { countPostmanBagInlineSecrets, redactPostmanBag, redactPostmanV3Raw } from './redaction';
import { getPostmanSidecar } from './sidecar';

/** PR #1210 review findings: sidecar scrub, broker encodings, examples, MCP stdio. */

const v3 = (items: unknown[]) => ({ $kind: 'collection', name: 'C', items });
const one = (item: Record<string, unknown>) => importPostmanCollection(v3([item]));
const first = (r: { collection: { items: CollectionItem[] } }) => r.collection.items[0]!;
const constructs = (ws: ReadonlyArray<{ kind: string; construct?: string }>) =>
  ws.map((w) => w.construct ?? w.kind);

describe('1: v3 raw scrub keeps structure and scripts intact', () => {
  it('authSets credentialKeys (key names) survive', () => {
    const r = one({
      $kind: 'http-request',
      name: 'R',
      url: 'https://x',
      auth: [
        { type: 'bearer', credentials: [{ key: 'token', value: 'T1' }] },
        { type: 'basic', credentials: [{ key: 'username', value: 'u' }] },
      ],
    });
    const bag = getPostmanSidecar(first(r));
    // Export / handle conversion re-walks the bag: key names must survive it.
    const redacted = redactPostmanBag(bag) as { authSets: Array<{ credentialKeys: unknown }> };
    expect(redacted.authSets.map((s) => s.credentialKeys)).toEqual([['token'], ['username']]);
    expect(countPostmanBagInlineSecrets(bag)).toBe(0);
    expect(JSON.stringify(bag)).not.toContain('T1');
  });

  it('a script holding a URL and a ternary is not truncated; embedded URL secrets still go', () => {
    const code = [
      "const u = 'https://user:pw@api.example.com/x?api_key=KEY1&page=2';",
      'const v = ok ? a?.b : c;',
      'pm.sendRequest(u);',
    ].join('\n');
    const out = redactPostmanV3Raw({ code }) as { code: string };
    expect(out.code).toContain('const v = ok ? a?.b : c;');
    expect(out.code).toContain('pm.sendRequest(u);');
    expect(out.code).not.toContain('user:pw@');
    expect(out.code).not.toContain('KEY1');
    expect(out.code).toContain('page=2');
    const bag = { scripts: [{ type: 'grpc:beforeInvoke', code }] };
    expect(countPostmanBagInlineSecrets(bag)).toBe(2);
    expect(JSON.stringify(redactPostmanBag(bag))).not.toContain('KEY1');
  });

  it('a lone URL value is still redacted whole', () => {
    expect(redactPostmanV3Raw({ u: 'https://a:b@h/p?token=T&x=1' })).toEqual({
      u: 'https://h/p?token=&x=1',
    });
  });
});

describe('2a / 2d / 2e: Kafka', () => {
  it('hex key / value are converted to base64 bytes', () => {
    const r = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'producer',
      url: 'b1:9092, b2:9092,,',
      messages: [
        {
          topic: 't',
          key: { contentType: 'hex', content: '6869' },
          value: { contentType: 'hex', content: 'DE AD be ef' },
        },
      ],
    });
    const k = first(r).request as KafkaRequest;
    expect(k.connection.bootstrapBrokers).toEqual(['b1:9092', 'b2:9092']);
    expect(k.produce).toMatchObject({
      key: 'aGk=',
      keyEncoding: 'base64',
      value: '3q2+7w==',
      valueEncoding: 'base64',
    });
  });

  it('hex that cannot be converted is warned and kept in the sidecar', () => {
    const r = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'producer',
      messages: [{ topic: 't', value: { contentType: 'hex', content: '{{payload}}' } }],
    });
    expect(constructs(r.report.warnings)).toContain('broker-leftovers');
    expect(getPostmanSidecar(first(r))?.leftovers).toMatchObject({
      value: { contentType: 'hex', content: '{{payload}}' },
    });
  });

  it('a timestamp start position keeps its value in the sidecar', () => {
    const r = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'consumer',
      topics: [{ name: 't' }],
      startPosition: { type: 'timestamp', timestamp: 1700000000000 },
    });
    expect((first(r).request as KafkaRequest).consume.mode).toBe('timestamp');
    expect(getPostmanSidecar(first(r))?.leftovers).toMatchObject({
      startPosition: { type: 'timestamp', timestamp: 1700000000000 },
    });
    expect(constructs(r.report.warnings)).toContain('broker-leftovers');
  });
});

describe('2b: MQTT payload encodings', () => {
  it('hex / base64 publish and last-will payloads are warned and recorded', () => {
    const r = one({
      $kind: 'mqtt-request',
      name: 'M',
      url: 'mqtt://b',
      messages: [
        { name: 'p', topic: 't', content: 'AQI=', contentType: 'base64' },
        { name: 'q', topic: 't', content: 'hi', contentType: 'text' },
      ],
      lastWill: { topic: 'w', payload: '0102', type: 'hex' },
    });
    const m = first(r).request as MqttRequest;
    expect(m.publish.payload).toBe('AQI=');
    expect(constructs(r.report.warnings)).toContain('broker-leftovers');
    expect(getPostmanSidecar(first(r))?.leftovers).toMatchObject({
      payloadEncodings: [
        { message: 'p', contentType: 'base64' },
        { message: 'lastWill', contentType: 'hex' },
      ],
    });
  });
});

describe('2c: non-HTTP examples keep their data', () => {
  it('gRPC messages and GraphQL / MQTT events land in the saved-response body', () => {
    const r = importPostmanCollection(
      v3([
        {
          $kind: 'grpc-request',
          name: 'G',
          url: 'h:1',
          examples: [{ name: 'e', response: { code: 0, messages: [{ content: '{"a":1}' }] } }],
        },
        {
          $kind: 'graphql-request',
          name: 'Q',
          url: 'https://g',
          examples: [{ name: 'e', response: { events: [{ content: '{"data":2}' }] } }],
        },
        {
          $kind: 'mqtt-request',
          name: 'M',
          url: 'mqtt://b',
          examples: [{ name: 'e', response: { events: [{ content: 'MQ_EVT' }] } }],
        },
      ])
    );
    const bodies = r.collection.items.map(
      (i) => (getPostmanSidecar(i)?.response?.[0] as { body: string }).body
    );
    expect(bodies[0]).toContain('{\\"a\\":1}');
    expect(bodies[1]).toContain('{\\"data\\":2}');
    expect(bodies[2]).toContain('MQ_EVT');
  });
});

describe('2f: MCP stdio imports disabled', () => {
  it('becomes a placeholder; launch config kept with env names only', () => {
    const r = one({
      $kind: 'mcp-request',
      name: 'S',
      transport: 'stdio',
      command: 'npx -y srv',
      env: [
        { key: 'DEBUG', value: 'ENV_VALUE_1' },
        { key: 'OFF', value: 'ENV_VALUE_2', disabled: true },
      ],
    });
    const item = first(r);
    expect(item.type).toBe('folder');
    expect(item.request).toBeUndefined();
    const kept = getPostmanSidecar(item)?.item as Record<string, unknown>;
    expect(kept).toMatchObject({
      transport: 'stdio',
      command: 'npx -y srv',
      argv: ['npx', '-y', 'srv'],
      env: [{ key: 'DEBUG' }, { key: 'OFF', disabled: true }],
    });
    expect(JSON.stringify(r.collection)).not.toContain('ENV_VALUE');
    expect(constructs(r.report.warnings)).toContain('mcp-stdio');
  });

  it('a non-stdio, non-sse MCP item stays a runnable streamable-HTTP request', () => {
    const r = one({ $kind: 'mcp-request', name: 'H', url: 'https://m/mcp' });
    expect(first(r).request).toMatchObject({ type: 'mcp', transport: 'streamable-http' });
  });
});

describe('#1210 edge branches', () => {
  it('odd-length hex, unknown encodings, unnamed MQTT messages, broker arrays', () => {
    const k = one({
      $kind: 'kafka-request',
      name: 'K',
      mode: 'producer',
      url: [' b1:9092 ', null, ''],
      messages: [
        { topic: 't', key: { contentType: 'hex', content: 'abc' }, value: { contentType: 'xml' } },
      ],
    });
    const kr = first(k).request as KafkaRequest;
    expect(kr.connection.bootstrapBrokers).toEqual(['b1:9092']);
    expect(kr.produce).toMatchObject({ key: 'abc', keyEncoding: 'utf8', valueEncoding: 'utf8' });
    expect(Object.keys(getPostmanSidecar(first(k))?.leftovers ?? {})).toEqual(['key', 'value']);
    const m = one({
      $kind: 'mqtt-request',
      name: 'M',
      messages: [{ topic: 't', content: '00', contentType: 'hex' }],
      lastWill: { topic: 'w', payload: 'x' },
    });
    expect(getPostmanSidecar(first(m))?.leftovers).toEqual({
      payloadEncodings: [{ message: '#1', contentType: 'hex' }],
    });
  });

  it('HTTP examples keep their string body; an empty non-HTTP response stays empty', () => {
    const r = importPostmanCollection(
      v3([
        {
          $kind: 'http-request',
          name: 'H',
          url: 'https://x',
          examples: [
            { name: 'a', response: { statusCode: 200, body: 'RAW' } },
            { name: 'b', response: { statusCode: 204 } },
          ],
        },
      ])
    );
    const res = getPostmanSidecar(first(r))?.response as Array<{ body: string }>;
    expect(res.map((x) => x.body)).toEqual(['RAW', '']);
  });
});
