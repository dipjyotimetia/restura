import { describe, expect, it } from 'vitest';
import { AgentTelemetryConfigSchema } from '../telemetry-config';

describe('agent telemetry configuration', () => {
  it('accepts HTTPS endpoints and loopback HTTP collectors only', () => {
    const secure = AgentTelemetryConfigSchema.parse({
      enabled: true,
      target: 'otlp',
      endpoint: 'https://collector.example/v1/traces',
      sampleRate: 1,
      environment: 'ci',
      auth: { mode: 'none' },
    });
    expect(secure.target).toBe('otlp');
    if (secure.target === 'otlp')
      expect(secure.endpoint).toBe('https://collector.example/v1/traces');

    const local = AgentTelemetryConfigSchema.parse({
      enabled: true,
      target: 'otlp',
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      sampleRate: 1,
      environment: 'local',
      auth: { mode: 'none' },
    });
    expect(local.target).toBe('otlp');
    if (local.target === 'otlp') expect(local.endpoint).toBe('http://127.0.0.1:4318/v1/traces');

    for (const endpoint of [
      'http://collector.internal/v1/traces',
      'https://collector.example/v1/traces?token=secret',
      'https://token@example.com/v1/traces',
      'https://169.254.169.254/v1/traces',
      'https://192.168.1.10/v1/traces',
    ]) {
      expect(() =>
        AgentTelemetryConfigSchema.parse({
          enabled: true,
          target: 'otlp',
          endpoint,
          sampleRate: 1,
          environment: 'ci',
          auth: { mode: 'none' },
        })
      ).toThrow();
    }
  });
});
