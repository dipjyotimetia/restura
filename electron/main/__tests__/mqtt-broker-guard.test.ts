// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { assertMqttBrokerSafe } from '../security/mqtt-broker-guard';

describe('assertMqttBrokerSafe', () => {
  it('accepts public mqtt:// and mqtts:// broker URLs', () => {
    expect(() => assertMqttBrokerSafe('mqtt://broker.hivemq.com:1883')).not.toThrow();
    expect(() => assertMqttBrokerSafe('mqtts://test.mosquitto.org:8883')).not.toThrow();
  });

  it('accepts private-network brokers — MQTT brokers routinely live on LAN/IoT nets', () => {
    expect(() => assertMqttBrokerSafe('mqtt://10.0.5.42:1883')).not.toThrow();
    expect(() => assertMqttBrokerSafe('mqtt://172.16.0.1:1883')).not.toThrow();
    expect(() => assertMqttBrokerSafe('mqtts://192.168.1.100:8883')).not.toThrow();
  });

  it('accepts localhost for local development', () => {
    expect(() => assertMqttBrokerSafe('mqtt://localhost:1883')).not.toThrow();
    expect(() => assertMqttBrokerSafe('mqtt://127.0.0.1:1883')).not.toThrow();
  });

  it('rejects cloud metadata literal IP (169.254.169.254)', () => {
    expect(() => assertMqttBrokerSafe('mqtt://169.254.169.254:1883')).toThrow(
      /MQTT broker .* rejected/
    );
  });

  it('rejects cloud metadata hostname (metadata.google.internal)', () => {
    expect(() => assertMqttBrokerSafe('mqtt://metadata.google.internal:1883')).toThrow(
      /MQTT broker .* rejected/
    );
  });

  it('rejects non-mqtt schemes (ws/http/tcp)', () => {
    expect(() => assertMqttBrokerSafe('ws://broker.example.com:8080')).toThrow(
      /MQTT broker .* rejected/
    );
    expect(() => assertMqttBrokerSafe('http://broker.example.com:1883')).toThrow(
      /MQTT broker .* rejected/
    );
    expect(() => assertMqttBrokerSafe('tcp://broker.example.com:1883')).toThrow(
      /MQTT broker .* rejected/
    );
  });

  it('rejects empty broker URL', () => {
    expect(() => assertMqttBrokerSafe('')).toThrow(/Invalid MQTT broker URL/);
  });

  it('rejects over-long broker URLs (DoS prevention)', () => {
    const huge = 'mqtt://' + 'a'.repeat(2100) + ':1883';
    expect(() => assertMqttBrokerSafe(huge)).toThrow(/Invalid MQTT broker URL/);
  });

  it('rejects malformed URLs', () => {
    expect(() => assertMqttBrokerSafe('not-a-url')).toThrow(/MQTT broker .* rejected/);
  });
});
