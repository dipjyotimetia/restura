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

  it('handles optional metadata and every exportable event category', () => {
    const payload = traceToOtlp({
      id: 'trace-optional',
      suiteId: 'suite',
      taskId: 'task',
      trial: 1,
      agentId: 'agent',
      startedAt: 10,
      events: [
        {
          id: 'model-without-usage',
          traceId: 'trace-optional',
          sequence: 0,
          timestamp: 12,
          type: 'model.completed',
          providerId: 'openai.responses',
          model: 'gpt',
          output: [],
          durationMs: 2,
          costUSD: 0.01,
        },
        {
          id: 'failed-model',
          traceId: 'trace-optional',
          sequence: 1,
          timestamp: 14,
          type: 'model.failed',
          providerId: 'openai.responses',
          model: 'gpt',
          error: 'kept local',
          durationMs: 2,
        },
        {
          id: 'completed-tool',
          traceId: 'trace-optional',
          sequence: 2,
          timestamp: 16,
          type: 'tool.completed',
          toolCallId: 'call',
          toolName: 'request',
          output: [],
          durationMs: 2,
        },
        {
          id: 'completed-run',
          traceId: 'trace-optional',
          sequence: 3,
          timestamp: 18,
          type: 'run.completed',
          status: 'passed',
        },
        {
          id: 'unexported-event',
          traceId: 'trace-optional',
          sequence: 4,
          timestamp: 20,
          type: 'agent.started',
        } as never,
      ],
    });
    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

    expect(spans.map((span) => span.name)).toEqual([
      'agent agent',
      'model gpt',
      'model gpt',
      'tool request',
    ]);
    expect(spans[0]?.endTimeUnixNano).toBe(spans[0]?.startTimeUnixNano);
  });
});
