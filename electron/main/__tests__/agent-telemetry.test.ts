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
});
