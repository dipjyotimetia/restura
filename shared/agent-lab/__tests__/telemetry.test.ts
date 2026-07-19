import { describe, expect, it } from 'vitest';
import { projectTraceForTelemetry, traceToOtlp } from '../telemetry';

describe('OpenTelemetry export', () => {
  it('projects only allowlisted metadata from a trace', () => {
    const projected = projectTraceForTelemetry({
      id: 'trace',
      suiteId: 'suite',
      taskId: 'task',
      trial: 1,
      agentId: 'agent',
      startedAt: 10,
      finishedAt: 20,
      events: [
        {
          id: 'model',
          traceId: 'trace',
          sequence: 0,
          timestamp: 12,
          type: 'model.completed',
          providerId: 'openai.responses',
          model: 'gpt',
          output: [{ type: 'text', text: 'never export this' }],
          durationMs: 5,
          usage: { inputTokens: 2, outputTokens: 1 },
        },
        {
          id: 'tool',
          traceId: 'trace',
          sequence: 1,
          timestamp: 16,
          type: 'tool.failed',
          toolCallId: 'call',
          toolName: 'request',
          error: 'Authorization: secret',
          durationMs: 2,
        },
      ],
    });

    expect(projected).toEqual({
      id: 'trace',
      suiteId: 'suite',
      taskId: 'task',
      trial: 1,
      agentId: 'agent',
      startedAt: 10,
      finishedAt: 20,
      events: [
        {
          id: 'model',
          type: 'model.completed',
          timestamp: 12,
          providerId: 'openai.responses',
          model: 'gpt',
          durationMs: 5,
          usage: { inputTokens: 2, outputTokens: 1 },
        },
        {
          id: 'tool',
          type: 'tool.failed',
          timestamp: 16,
          toolName: 'request',
          durationMs: 2,
        },
      ],
    });
  });

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
