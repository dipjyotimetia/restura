import { describe, expect, it } from 'vitest';
import {
  MqttConnectSchema,
  MqttPublishSchema,
  MqttSubscribeSchema,
  MqttUnsubscribeSchema,
  MqttDisconnectSchema,
} from '../ipc-validators';

const baseConnect = {
  connectionId: 'conn-1',
  brokerUrl: 'mqtt://localhost:1883',
  protocolVersion: 5 as const,
  clientId: 'restura-test',
  keepalive: 60,
  cleanStart: true,
  connectTimeout: 30_000,
  autoReconnect: true,
};

describe('MQTT IPC validators', () => {
  describe('MqttConnectSchema', () => {
    it('accepts a minimal v5 config', () => {
      expect(MqttConnectSchema.safeParse(baseConnect).success).toBe(true);
    });

    it('accepts a v3.1.1 config with TLS, LWT, and credentials', () => {
      const result = MqttConnectSchema.safeParse({
        ...baseConnect,
        brokerUrl: 'mqtts://broker.example.com:8883',
        protocolVersion: 4,
        username: 'user',
        password: 'secret',
        tls: { ca: '---PEM---', rejectUnauthorized: true },
        lwt: { topic: 'devices/x/status', payload: 'offline', qos: 1, retain: true },
        sessionExpiryInterval: 3600,
      });
      expect(result.success).toBe(true);
    });

    it('rejects a non-mqtt broker scheme (ws://)', () => {
      const result = MqttConnectSchema.safeParse({
        ...baseConnect,
        brokerUrl: 'ws://broker.example.com:8080',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an out-of-range protocol version', () => {
      const result = MqttConnectSchema.safeParse({ ...baseConnect, protocolVersion: 3 });
      expect(result.success).toBe(false);
    });

    it('rejects a LWT topic containing wildcards', () => {
      const result = MqttConnectSchema.safeParse({
        ...baseConnect,
        lwt: { topic: 'devices/+/status', payload: 'x', qos: 0, retain: false },
      });
      expect(result.success).toBe(false);
    });

    it('rejects a missing required field (clientId)', () => {
      const { clientId: _drop, ...rest } = baseConnect;
      expect(MqttConnectSchema.safeParse(rest).success).toBe(false);
    });
  });

  describe('MqttPublishSchema', () => {
    it('accepts a concrete topic with v5 extras', () => {
      const result = MqttPublishSchema.safeParse({
        connectionId: 'conn-1',
        topic: 'restura/test',
        payload: 'hello',
        qos: 1,
        retain: false,
        userProperties: { trace: 'abc' },
        contentType: 'text/plain',
        responseTopic: 'restura/reply',
      });
      expect(result.success).toBe(true);
    });

    it('rejects a publish topic containing wildcards (+ or #)', () => {
      expect(
        MqttPublishSchema.safeParse({
          connectionId: 'c',
          topic: 'restura/+/x',
          payload: '',
          qos: 0,
          retain: false,
        }).success
      ).toBe(false);
      expect(
        MqttPublishSchema.safeParse({
          connectionId: 'c',
          topic: 'restura/#',
          payload: '',
          qos: 0,
          retain: false,
        }).success
      ).toBe(false);
    });

    it('rejects an out-of-range QoS', () => {
      expect(
        MqttPublishSchema.safeParse({
          connectionId: 'c',
          topic: 't',
          payload: '',
          qos: 3,
          retain: false,
        }).success
      ).toBe(false);
    });
  });

  describe('MqttSubscribeSchema', () => {
    it('accepts single-level (+) and multi-level (#) wildcards', () => {
      expect(
        MqttSubscribeSchema.safeParse({ connectionId: 'c', topicFilter: 'home/+/temp', qos: 1 })
          .success
      ).toBe(true);
      expect(
        MqttSubscribeSchema.safeParse({ connectionId: 'c', topicFilter: 'home/#', qos: 0 }).success
      ).toBe(true);
      expect(
        MqttSubscribeSchema.safeParse({
          connectionId: 'c',
          topicFilter: '$SYS/broker/uptime',
          qos: 0,
        }).success
      ).toBe(true);
    });

    it('rejects # in a non-final level', () => {
      expect(
        MqttSubscribeSchema.safeParse({ connectionId: 'c', topicFilter: 'home/#/x', qos: 0 })
          .success
      ).toBe(false);
    });

    it('rejects + adjacent to other characters within a level', () => {
      expect(
        MqttSubscribeSchema.safeParse({ connectionId: 'c', topicFilter: 'ho+me/x', qos: 0 }).success
      ).toBe(false);
    });
  });

  describe('MqttUnsubscribeSchema / MqttDisconnectSchema', () => {
    it('accept canonical shapes', () => {
      expect(
        MqttUnsubscribeSchema.safeParse({ connectionId: 'c', topicFilter: 'home/#' }).success
      ).toBe(true);
      expect(MqttDisconnectSchema.safeParse({ connectionId: 'c' }).success).toBe(true);
    });

    it('reject a bad connectionId', () => {
      expect(MqttDisconnectSchema.safeParse({ connectionId: 'has spaces!' }).success).toBe(false);
    });
  });
});
