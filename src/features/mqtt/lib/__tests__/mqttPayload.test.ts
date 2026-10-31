import { describe, expect, it, vi } from 'vitest';
import {
  decodeMqttBinary,
  displayMqttBinary,
  encodeMqttPayload,
  mqttBinaryLength,
} from '@/features/mqtt/lib/mqttPayload';
import { describeServerDisconnect, mqttReasonCodeName } from '@/features/mqtt/lib/mqttReasonCodes';

describe('mqttPayload (MQTT-2)', () => {
  it('encodes text and JSON as utf8, hex and base64 as base64', () => {
    expect(encodeMqttPayload('héllo', 'text')).toEqual({
      payload: 'héllo',
      payloadEncoding: 'utf8',
    });
    expect(encodeMqttPayload('{"a":1}', 'json')).toEqual({
      payload: '{"a":1}',
      payloadEncoding: 'utf8',
    });
    expect(encodeMqttPayload('de ad 0xBE:ef', 'hex')).toEqual({
      payload: '3q2+7w==',
      payloadEncoding: 'base64',
    });
    expect(encodeMqttPayload('3q2+7w', 'base64')).toEqual({
      payload: '3q2+7w==',
      payloadEncoding: 'base64',
    });
  });

  it('rejects malformed JSON / hex / base64 with a readable error', () => {
    expect(() => encodeMqttPayload('{', 'json')).toThrow(/not valid JSON/);
    expect(() => encodeMqttPayload('abc', 'hex')).toThrow(/even number/);
    expect(() => encodeMqttPayload('zz!', 'base64')).toThrow(/not valid base64/);
  });

  it('round-trips every byte value through hex and base64', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const { payload, payloadEncoding } = encodeMqttPayload(hex, 'hex');
    expect(decodeMqttBinary(payload, payloadEncoding)).toEqual(bytes);
    expect(mqttBinaryLength(payload, payloadEncoding)).toBe(256);
  });

  it('displays binary as hex (default) or base64, text unchanged', () => {
    expect(displayMqttBinary('3q2+7w==', 'base64')).toBe('de ad be ef');
    expect(displayMqttBinary('3q2+7w==', 'base64', 'base64')).toBe('3q2+7w==');
    expect(displayMqttBinary('plain', 'utf8')).toBe('plain');
  });
});

describe('mqttReasonCodes (MQTT-6)', () => {
  it('names known reason codes and falls back to hex for unknown ones', () => {
    expect(mqttReasonCodeName(0x8e)).toBe('Session taken over (0x8E)');
    expect(mqttReasonCodeName(0x97)).toBe('Quota exceeded (0x97)');
    expect(mqttReasonCodeName(0x00)).toBe('Normal disconnection (0x00)');
    expect(mqttReasonCodeName(0x7f)).toBe('Reason code 0x7F');
  });

  it('formats a server DISCONNECT with reason string and server reference', () => {
    expect(
      describeServerDisconnect({
        reasonCode: 0x9c,
        reasonString: 'maintenance',
        serverReference: 'b2',
      })
    ).toBe(
      'Disconnected by server: Use another server (0x9C) — maintenance (server reference: b2)'
    );
  });
});

describe('mqttPayload — remaining branches', () => {
  it('decodes utf8 (default) binary fields as text bytes', () => {
    expect(Array.from(decodeMqttBinary('hi', undefined))).toEqual([104, 105]);
    expect(Array.from(decodeMqttBinary('hi', 'utf8'))).toEqual([104, 105]);
    expect(mqttBinaryLength('é', 'utf8')).toBe(2);
  });

  it('stringifies a non-Error thrown by JSON.parse', () => {
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw 'plain string failure';
    });
    try {
      expect(() => encodeMqttPayload('{}', 'json')).toThrow(
        'Payload is not valid JSON: plain string failure'
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('describes a server disconnect with a code that is not in the table', () => {
    expect(describeServerDisconnect({ reasonCode: 0xff })).toBe(
      'Disconnected by server: Reason code 0xFF'
    );
    expect(mqttReasonCodeName(0x05)).toBe('Reason code 0x05');
  });
});
