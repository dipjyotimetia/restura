import type { AgentTelemetryConfig } from './telemetry-config';
import type { RedactedTrace, RedactedTraceEvent } from './telemetry-redaction';
import type { OtlpTracePayload } from './telemetry';

// ── OTLP attribute helpers (re-use the same shape as telemetry.ts) ──────────

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

const stringAttribute = (key: string, value: string): OtlpAttribute => ({
  key,
  value: { stringValue: value },
});
const intAttribute = (key: string, value: number): OtlpAttribute => ({
  key,
  value: { intValue: String(value) },
});
const nanos = (milliseconds: number): string => String(Math.round(milliseconds * 1_000_000));

// ── Deterministic hex ID generation (mirrors telemetry.ts) ──────────────────

function hexId(value: string, length: number): string {
  let hash = 0x811c9dc5;
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

// ── RedactedTrace → OTLP ────────────────────────────────────────────────────

function eventSpan(
  event: RedactedTraceEvent,
  traceId: string,
  parentSpanId: string,
): OtlpSpan | undefined {
  switch (event.type) {
    case 'model.completed': {
      return {
        traceId,
        spanId: hexId(`${traceId}:event:${event.type}:${event.model}`, 16),
        parentSpanId,
        name: `model ${event.model}`,
        kind: 3, // SPAN_KIND_INTERNAL
        startTimeUnixNano: nanos(event.durationMs),
        endTimeUnixNano: '0',
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
          ...(event.costUSD !== undefined
            ? [intAttribute('gen_ai.usage.cost_usd', Math.round(event.costUSD * 1_000_000))]
            : []),
        ],
      };
    }
    case 'tool.completed':
    case 'tool.failed': {
      return {
        traceId,
        spanId: hexId(`${traceId}:event:${event.type}:${event.toolName}`, 16),
        parentSpanId,
        name: `tool ${event.toolName}`,
        kind: 3,
        startTimeUnixNano: nanos(event.durationMs),
        endTimeUnixNano: '0',
        attributes: [
          stringAttribute('openinference.span.kind', 'TOOL'),
          stringAttribute('tool.name', event.toolName),
          ...(event.type === 'tool.failed' ? [stringAttribute('error.message', event.error)] : []),
        ],
      };
    }
    case 'model.failed': {
      return {
        traceId,
        spanId: hexId(`${traceId}:event:${event.type}:${event.model}`, 16),
        parentSpanId,
        name: `model ${event.model}`,
        kind: 3,
        startTimeUnixNano: nanos(event.durationMs),
        endTimeUnixNano: '0',
        attributes: [
          stringAttribute('openinference.span.kind', 'LLM'),
          stringAttribute('gen_ai.system', event.providerId),
          stringAttribute('gen_ai.request.model', event.model),
          stringAttribute('error.message', event.error),
        ],
      };
    }
    default:
      return undefined;
  }
}

/**
 * Convert a redacted trace to an OTLP/HTTP JSON payload suitable for
 * ingestion by any OpenTelemetry-compatible collector (including Langfuse).
 */
export function redactedTraceToOtlp(trace: RedactedTrace): OtlpTracePayload {
  const traceId = hexId(trace.id, 32);
  const rootSpanId = hexId(`${trace.id}:root`, 16);

  const rootAttributes: OtlpAttribute[] = [
    stringAttribute('openinference.span.kind', 'AGENT'),
    stringAttribute('agent.id', trace.agentId),
    stringAttribute('eval.suite.id', trace.suiteId),
    stringAttribute('eval.task.id', trace.taskId),
    intAttribute('eval.trial', trace.trial),
    stringAttribute('ml_app_name', 'restura-agent-lab'),
  ];

  const root: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: `agent ${trace.agentId}`,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(trace.startedAt),
    endTimeUnixNano: nanos(trace.finishedAt ?? trace.startedAt),
    attributes: rootAttributes,
  };

  const spans: OtlpSpan[] = [
    root,
    ...trace.events
      .map((event) => eventSpan(event, traceId, rootSpanId))
      .filter((span): span is OtlpSpan => Boolean(span)),
  ];

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute('service.name', 'restura-agent-lab'),
            stringAttribute('deployment.environment', 'production'),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'restura.agent-lab', version: '2' },
            spans,
          },
        ],
      },
    ],
  };
}

// ── Exporter ────────────────────────────────────────────────────────────────

export interface ExporterDependencies {
  fetch: typeof fetch;
  now: () => number;
}

export interface ExportResult {
  success: boolean;
  statusCode?: number;
  durationMs: number;
  error?: string;
}

/**
 * Export a telemetry payload to an OTLP/HTTP endpoint.
 *
 * The exporter is:
 * - Bounded (timeout enforced via AbortSignal)
 * - Cancellable (accepts external AbortSignal)
 * - Retry-safe (returns a result object, never throws on network errors)
 * - Isolated (cannot affect agent execution success)
 */
export async function exportOtlpPayload(
  payload: OtlpTracePayload,
  config: AgentTelemetryConfig,
  options: { signal?: AbortSignal; deps?: Partial<ExporterDependencies> } = {}
): Promise<ExportResult> {
  const deps: ExporterDependencies = {
    fetch: options.deps?.fetch ?? globalThis.fetch,
    now: options.deps?.now ?? Date.now,
  };

  const startedAt = deps.now();

  try {
    const controller = new AbortController();

    // Wire external cancellation
    const onAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      controller.abort(options.signal.reason);
    }

    // Timeout: 10 seconds for the whole request
    const timeoutId = setTimeout(() => controller.abort('export timeout'), 10_000);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };

      // Resolve auth header from environment
      if (config.auth) {
        const token = await resolveAuthToken(config.auth, deps);
        if (token) {
          headers['authorization'] = `Bearer ${token}`;
        }
      }

      const response = await deps.fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const durationMs = deps.now() - startedAt;
      return {
        success: response.ok,
        statusCode: response.status,
        durationMs,
        ...(response.ok ? {} : { error: `HTTP ${response.status} ${response.statusText}` }),
      };
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    const durationMs = deps.now() - startedAt;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        success: false,
        durationMs,
        error: options.signal?.aborted ? 'cancelled' : 'timeout',
      };
    }
    return {
      success: false,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveAuthToken(
  auth: { kind: 'env'; name: string },
  deps: ExporterDependencies
): Promise<string | undefined> {
  // In Node.js and Workers, the token lives in process.env / globalThis env
  const token =
    typeof process !== 'undefined' && process.env
      ? process.env[auth.name]
      : (globalThis as Record<string, unknown>)[auth.name];
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

// ── Sampling ────────────────────────────────────────────────────────────────

/**
 * Deterministic sampling decision based on trace ID and sample rate.
 * Returns true if the trace should be exported.
 */
export function shouldSample(traceId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  // Use FNV-1a hash of the trace ID to get a deterministic value in [0, 1)
  let hash = 0x811c9dc5;
  for (let i = 0; i < traceId.length; i++) {
    hash ^= traceId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 0x100000000;
  return normalized < sampleRate;
}