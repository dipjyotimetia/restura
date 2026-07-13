import { describe, expect, it } from 'vitest';
import { traceToOtlp } from '../telemetry';

describe('OpenTelemetry export', () => {
  it('maps a trace to OTLP spans with OpenInference semantic attributes', () => {
    const payload = traceToOtlp({
      id: 'trace',
      suiteId: 'suite',
      taskId: 'task',
      trial: 1,
      agentId: 'agent',
      startedAt: 10,
      finishedAt: 20,
      events: [
        {
          id: 'event',
          traceId: 'trace',
          sequence: 0,
          timestamp: 12,
          type: 'model.completed',
          providerId: 'openai.responses',
          model: 'gpt',
          output: [{ type: 'text', text: 'ok' }],
          durationMs: 5,
          usage: { inputTokens: 2, outputTokens: 1 },
        },
      ],
    });
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((span) => span.name)).toEqual(['agent agent', 'model gpt']);
    expect(spans[1]?.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'openinference.span.kind', value: { stringValue: 'LLM' } }),
      ])
    );
  });
});
