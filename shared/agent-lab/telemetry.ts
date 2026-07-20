import type { Trace, TraceEvent } from './types';

/**
 * The only agent-run data eligible for external telemetry. This intentionally
 * omits all content, credentials, URLs, request arguments, and error text.
 */
export interface TelemetryTrace {
  id: string;
  suiteId: string;
  taskId: string;
  trial: number;
  agentId: string;
  startedAt: number;
  finishedAt?: number;
  events: TelemetryTraceEvent[];
}

export type TelemetryTraceEvent =
  | {
      id: string;
      type: 'model.completed';
      timestamp: number;
      providerId: string;
      model: string;
      durationMs: number;
      usage?: { inputTokens: number; outputTokens: number };
      costUSD?: number;
    }
  | {
      id: string;
      type: 'model.failed';
      timestamp: number;
      providerId: string;
      model: string;
      durationMs: number;
    }
  | {
      id: string;
      type: 'tool.completed' | 'tool.failed';
      timestamp: number;
      toolName: string;
      durationMs: number;
    }
  | { id: string; type: 'run.completed'; timestamp: number; status: string };

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

function eventSpan(
  event: TelemetryTraceEvent,
  traceId: string,
  parentSpanId: string
): OtlpSpan | undefined {
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
  if (event.type === 'model.failed') {
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
        stringAttribute('error.type', 'model.failure'),
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

function projectEvent(event: TraceEvent): TelemetryTraceEvent | undefined {
  switch (event.type) {
    case 'model.completed':
      return {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        providerId: event.providerId,
        model: event.model,
        durationMs: event.durationMs,
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.costUSD === undefined ? {} : { costUSD: event.costUSD }),
      };
    case 'model.failed':
      return {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        providerId: event.providerId,
        model: event.model,
        durationMs: event.durationMs,
      };
    case 'tool.completed':
    case 'tool.failed':
      return {
        id: event.id,
        type: event.type,
        timestamp: event.timestamp,
        toolName: event.toolName,
        durationMs: event.durationMs,
      };
    case 'run.completed':
      return { id: event.id, type: event.type, timestamp: event.timestamp, status: event.status };
    default:
      return undefined;
  }
}

/** Projects a raw agent trace to the strict metadata-only telemetry contract. */
export function projectTraceForTelemetry(trace: Trace): TelemetryTrace {
  return {
    id: trace.id,
    suiteId: trace.suiteId,
    taskId: trace.taskId,
    trial: trace.trial,
    agentId: trace.agentId,
    startedAt: trace.startedAt,
    ...(trace.finishedAt === undefined ? {} : { finishedAt: trace.finishedAt }),
    events: trace.events
      .map(projectEvent)
      .filter((event): event is TelemetryTraceEvent => event !== undefined),
  };
}

/** Exportable OTLP/HTTP JSON with OpenInference attributes; no telemetry is sent automatically. */
export function traceToOtlp(trace: Trace): OtlpTracePayload {
  return telemetryTraceToOtlp(projectTraceForTelemetry(trace));
}

/** Converts an already projected telemetry trace to OTLP/HTTP JSON. */
export function telemetryTraceToOtlp(safeTrace: TelemetryTrace): OtlpTracePayload {
  const traceId = hexId(safeTrace.id, 32);
  const rootSpanId = hexId(`${safeTrace.id}:root`, 16);
  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: `agent ${safeTrace.agentId}`,
    kind: 1,
    startTimeUnixNano: nanos(safeTrace.startedAt),
    endTimeUnixNano: nanos(safeTrace.finishedAt ?? safeTrace.startedAt),
    attributes: [
      stringAttribute('openinference.span.kind', 'AGENT'),
      stringAttribute('agent.id', safeTrace.agentId),
      stringAttribute('eval.suite.id', safeTrace.suiteId),
      stringAttribute('eval.task.id', safeTrace.taskId),
      intAttribute('eval.trial', safeTrace.trial),
    ],
  };
  const spans = [
    root,
    ...safeTrace.events
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
