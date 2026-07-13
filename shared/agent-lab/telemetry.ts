import type { Trace, TraceEvent } from './types';

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}
export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

function hexId(value: string, length: number): string {
  let hash = 2166136261;
  let output = '';
  for (let round = 0; output.length < length; round += 1) {
    for (const character of `${value}:${round}`) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    output += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return output.slice(0, length);
}

const stringAttribute = (key: string, value: string): OtlpAttribute => ({
  key,
  value: { stringValue: value },
});
const intAttribute = (key: string, value: number): OtlpAttribute => ({
  key,
  value: { intValue: String(value) },
});
const nanos = (milliseconds: number): string => String(Math.round(milliseconds * 1_000_000));

function eventSpan(event: TraceEvent, traceId: string, parentSpanId: string): OtlpSpan | undefined {
  if (event.type === 'model.completed') {
    return {
      traceId,
      spanId: hexId(event.id, 16),
      parentSpanId,
      name: `model ${event.model}`,
      kind: 3,
      startTimeUnixNano: nanos(event.timestamp - event.durationMs),
      endTimeUnixNano: nanos(event.timestamp),
      attributes: [
        stringAttribute('openinference.span.kind', 'LLM'),
        stringAttribute('gen_ai.system', event.providerId),
        stringAttribute('gen_ai.request.model', event.model),
        ...(event.usage
          ? [
              intAttribute('gen_ai.usage.input_tokens', event.usage.inputTokens),
              intAttribute('gen_ai.usage.output_tokens', event.usage.outputTokens),
            ]
          : []),
      ],
    };
  }
  if (event.type === 'tool.completed' || event.type === 'tool.failed') {
    return {
      traceId,
      spanId: hexId(event.id, 16),
      parentSpanId,
      name: `tool ${event.toolName}`,
      kind: 3,
      startTimeUnixNano: nanos(event.timestamp - event.durationMs),
      endTimeUnixNano: nanos(event.timestamp),
      attributes: [
        stringAttribute('openinference.span.kind', 'TOOL'),
        stringAttribute('tool.name', event.toolName),
      ],
    };
  }
  return undefined;
}

/** Exportable OTLP/HTTP JSON with OpenInference attributes; no telemetry is sent automatically. */
export function traceToOtlp(trace: Trace): OtlpTracePayload {
  const traceId = hexId(trace.id, 32);
  const rootSpanId = hexId(`${trace.id}:root`, 16);
  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: `agent ${trace.agentId}`,
    kind: 1,
    startTimeUnixNano: nanos(trace.startedAt),
    endTimeUnixNano: nanos(trace.finishedAt ?? trace.startedAt),
    attributes: [
      stringAttribute('openinference.span.kind', 'AGENT'),
      stringAttribute('agent.id', trace.agentId),
      stringAttribute('eval.suite.id', trace.suiteId),
      stringAttribute('eval.task.id', trace.taskId),
      intAttribute('eval.trial', trace.trial),
    ],
  };
  const spans = [
    root,
    ...trace.events
      .map((event) => eventSpan(event, traceId, rootSpanId))
      .filter((span): span is OtlpSpan => Boolean(span)),
  ];
  return {
    resourceSpans: [
      {
        resource: { attributes: [stringAttribute('service.name', 'restura-agent-lab')] },
        scopeSpans: [{ scope: { name: 'restura.agent-lab', version: '2' }, spans }],
      },
    ],
  };
}
