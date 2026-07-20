import { describe, expect, it, vi } from 'vitest';
import { createAgentTelemetryService, type TelemetryPipeline } from '../lifecycle/agent-telemetry';
import type { TelemetryTrace } from '../../../shared/agent-lab/telemetry';

const trace: TelemetryTrace = {
  id: 'trace',
  suiteId: 'suite',
  taskId: 'task',
  trial: 1,
  agentId: 'agent',
  startedAt: 10,
  finishedAt: 20,
  events: [],
};

describe('agent telemetry service', () => {
  it('exports a metadata-only OTLP trace without changing the run outcome', async () => {
    const exportTrace = vi.fn<TelemetryPipeline['exportTrace']>().mockResolvedValue(undefined);
    const service = createAgentTelemetryService({
      createPipeline: async () => ({
        exportTrace,
        flush: async () => {},
        shutdown: async () => {},
      }),
    });

    const delivery = service.enqueue(trace, {
      enabled: true,
      target: 'otlp',
      endpoint: 'https://collector.example/v1/traces',
      environment: 'ci',
      sampleRate: 1,
      auth: { mode: 'none' },
    });

    await service.flush();

    expect(delivery.status).toBe('sent');
    expect(exportTrace).toHaveBeenCalledWith(trace);
  });

  it('retries pipeline creation after a transient initialization failure', async () => {
    const exportTrace = vi.fn<TelemetryPipeline['exportTrace']>().mockResolvedValue(undefined);
    const createPipeline = vi
      .fn<() => Promise<TelemetryPipeline>>()
      .mockRejectedValueOnce(new Error('temporary credential lookup failure'))
      .mockResolvedValueOnce({ exportTrace, flush: async () => {}, shutdown: async () => {} });
    const service = createAgentTelemetryService({ createPipeline });
    const config = {
      enabled: true,
      target: 'otlp' as const,
      endpoint: 'https://collector.example/v1/traces',
      environment: 'ci',
      sampleRate: 1,
      auth: { mode: 'none' as const },
    };

    const failed = service.enqueue(trace, config);
    await service.flush();
    const recovered = service.enqueue({ ...trace, id: 'recovered-trace' }, config);
    await service.flush();

    expect(failed.status).toBe('failed');
    expect(recovered.status).toBe('sent');
    expect(createPipeline).toHaveBeenCalledTimes(2);
  });

  it('keeps an initialized pipeline after an individual delivery fails', async () => {
    const exportTrace = vi
      .fn<TelemetryPipeline['exportTrace']>()
      .mockRejectedValueOnce(new Error('collector unavailable'))
      .mockResolvedValueOnce(undefined);
    const createPipeline = vi.fn<() => Promise<TelemetryPipeline>>().mockResolvedValue({
      exportTrace,
      flush: async () => {},
      shutdown: async () => {},
    });
    const service = createAgentTelemetryService({ createPipeline });
    const config = {
      enabled: true,
      target: 'otlp' as const,
      endpoint: 'https://collector.example/v1/traces',
      environment: 'ci',
      sampleRate: 1,
      auth: { mode: 'none' as const },
    };

    const failed = service.enqueue(trace, config);
    await service.flush();
    const recovered = service.enqueue({ ...trace, id: 'recovered-trace' }, config);
    await service.flush();

    expect(failed.status).toBe('failed');
    expect(recovered.status).toBe('sent');
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });
});
