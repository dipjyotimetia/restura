import { describe, expect, it } from 'vitest';
import type { Collection, CollectionItem, CollectionRequest } from '../../types';
import { countCollectionInlineSecrets, redactCollectionSecrets } from '../collection-redaction';
import {
  blankRequestSecrets,
  countRequestSecrets,
  REQUEST_SECRET_SLOTS,
} from '../request-secret-slots';
import { blankSecretSlots, countSecretSlots, type SecretSlot } from '../secret-slot';

function row(key: string, value: string, extra: Record<string, unknown> = {}) {
  return { id: key, key, value, enabled: true, ...extra };
}

const KAFKA_CLEAN = {
  type: 'kafka',
  connection: { bootstrapBrokers: [] },
  produce: { headers: [] },
};
const MQTT_CLEAN = {
  type: 'mqtt',
  connection: { brokerUrl: 'mqtt://broker.test' },
  publish: {},
  templates: [],
};
const SOCKETIO_CLEAN = { type: 'socketio', url: 'https://s.test', handshakeAuth: [], query: [] };

/**
 * One request per slot, holding a secret in that slot ONLY, with the number of
 * secrets it holds. A slot without a sample fails the exhaustiveness test, so
 * nobody can add a slot without proving both its actions here.
 */
const SAMPLES: Record<string, { request: Record<string, unknown>; secrets: number }> = {
  headers: { request: { type: 'http', headers: [row('Authorization', 'PLAIN')] }, secrets: 1 },
  params: { request: { type: 'http', params: [row('api_key', 'PLAIN')] }, secrets: 1 },
  metadata: { request: { type: 'grpc', metadata: [row('authorization', 'PLAIN')] }, secrets: 1 },
  formBody: {
    request: {
      type: 'http',
      body: { type: 'form-data', formData: [row('password', 'PLAIN')] },
    },
    secrets: 1,
  },
  auth: {
    request: { type: 'http', auth: { type: 'bearer', bearer: { token: 'PLAIN' } } },
    secrets: 1,
  },
  stdioEnv: {
    request: { type: 'mcp', stdio: { env: [row('API_TOKEN', 'PLAIN')] } },
    secrets: 1,
  },
  'kafka.bootstrapBrokers': {
    request: {
      ...KAFKA_CLEAN,
      connection: { bootstrapBrokers: ['u:PLAIN@b1:9092', 'u:PLAIN@b2:9092'] },
    },
    secrets: 2,
  },
  'kafka.registry': {
    request: {
      ...KAFKA_CLEAN,
      connection: { bootstrapBrokers: [], registry: { url: 'https://u:PLAIN@r.test' } },
    },
    secrets: 1,
  },
  'kafka.produceHeaders': {
    request: { ...KAFKA_CLEAN, produce: { headers: [row('x-api-key', 'PLAIN')] } },
    secrets: 1,
  },
  'mqtt.brokerUrl': {
    request: { ...MQTT_CLEAN, connection: { brokerUrl: 'mqtt://u:PLAIN@broker.test' } },
    secrets: 1,
  },
  'mqtt.publish': {
    request: { ...MQTT_CLEAN, publish: { userProperties: { token: 'PLAIN' } } },
    secrets: 1,
  },
  'mqtt.templates': {
    request: {
      ...MQTT_CLEAN,
      templates: [{ name: 't', userProperties: { token: 'PLAIN', password: 'PLAIN' } }],
    },
    secrets: 2,
  },
  'websocket.url': {
    request: { type: 'websocket', url: 'wss://u:PLAIN@ws.test?token=PLAIN' },
    secrets: 2,
  },
  'socketio.url': {
    request: { ...SOCKETIO_CLEAN, url: 'https://u:PLAIN@s.test?token=PLAIN' },
    secrets: 2,
  },
  'socketio.handshakeAuth': {
    request: { ...SOCKETIO_CLEAN, handshakeAuth: [row('anything', 'PLAIN')] },
    secrets: 1,
  },
  'socketio.handshakeAuthJson': {
    request: { ...SOCKETIO_CLEAN, handshakeAuthJson: '{"a":"PLAIN","b":{"c":"PLAIN"}}' },
    secrets: 2,
  },
  'socketio.query': {
    request: { ...SOCKETIO_CLEAN, query: [row('api_key', 'PLAIN')] },
    secrets: 1,
  },
};

const asRequest = (request: Record<string, unknown>) => request as unknown as CollectionRequest;

const SLOT_CASES = REQUEST_SECRET_SLOTS.map((slot) => [slot.name, slot] as const);

describe('request secret slots', () => {
  it('every slot has a sample, and every sample names a real slot', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(REQUEST_SECRET_SLOTS.map((s) => s.name).sort());
  });

  it('slot names are unique', () => {
    const names = REQUEST_SECRET_SLOTS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('a slot cannot be defined with only one action', () => {
    // @ts-expect-error blank without count must not compile
    const noCount: SecretSlot = { name: 'x', blank: (r) => r };
    // @ts-expect-error count without blank must not compile
    const noBlank: SecretSlot = { name: 'x', count: () => 0 };
    expect([noCount.name, noBlank.name]).toEqual(['x', 'x']);
  });

  describe.each(SLOT_CASES)('%s', (name, slot) => {
    const sample = SAMPLES[name] as { request: Record<string, unknown>; secrets: number };
    const request = asRequest(sample.request);

    it('counts the secrets it holds, and only this slot sees them', () => {
      expect(slot.count(request)).toBe(sample.secrets);
      expect(countRequestSecrets(request)).toBe(sample.secrets);
    });

    it('blanks what it counted, leaving nothing for either action to find', () => {
      const blanked = slot.blank(request);
      expect(JSON.stringify(blanked)).not.toContain('PLAIN');
      expect(slot.count(blanked)).toBe(0);
      expect(JSON.stringify(blankRequestSecrets(request))).not.toContain('PLAIN');
      expect(countRequestSecrets(blankRequestSecrets(request))).toBe(0);
    });

    it('does not mutate the request', () => {
      const before = JSON.stringify(sample.request);
      slot.blank(request);
      blankRequestSecrets(request);
      expect(JSON.stringify(sample.request)).toBe(before);
    });

    it('the collection walks reach it through the one list', () => {
      const collection = {
        id: 'c',
        name: 'c',
        items: [{ id: 'i', name: 'i', type: 'request', request } as CollectionItem],
      } as Collection;
      expect(countCollectionInlineSecrets(collection)).toBe(sample.secrets);
      const redacted = redactCollectionSecrets(collection);
      expect(JSON.stringify(redacted)).not.toContain('PLAIN');
      expect(countCollectionInlineSecrets(redacted)).toBe(0);
    });
  });

  it('a kind-scoped slot ignores every other kind', () => {
    const http = asRequest({ type: 'http', url: 'https://u:PLAIN@h.test' });
    for (const slot of REQUEST_SECRET_SLOTS.filter((s) => s.name.includes('.'))) {
      expect(slot.blank(http)).toBe(http);
      expect(slot.count(http)).toBe(0);
    }
  });
});

describe('slot folds', () => {
  const add = (field: string): SecretSlot => ({
    name: field,
    blank: (r) => ({ ...r, [field]: '' }) as CollectionRequest,
    count: (r) => ((r as unknown as Record<string, unknown>)[field] ? 1 : 0),
  });
  const slots = [add('a'), add('b')];
  const request = asRequest({ type: 'http', a: 'x', b: 'y', c: 'z' });

  it('a slot in the list takes part in both actions', () => {
    expect(countSecretSlots(slots, request)).toBe(2);
    expect(blankSecretSlots(slots, request)).toEqual({ type: 'http', a: '', b: '', c: 'z' });
    expect(countSecretSlots(slots, blankSecretSlots(slots, request))).toBe(0);
    expect(request).toEqual({ type: 'http', a: 'x', b: 'y', c: 'z' });
  });

  it('an empty list returns the same request and counts nothing', () => {
    expect(blankSecretSlots([], request)).toBe(request);
    expect(countSecretSlots([], request)).toBe(0);
  });
});
