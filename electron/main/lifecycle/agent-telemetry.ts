import { context, SpanKind, trace as otelTrace, type Span, type Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import type {
  AgentTelemetryConfig,
  TelemetryCredentialRef,
} from '@shared/agent-lab/telemetry-config';
import type { TelemetryTrace, TelemetryTraceEvent } from '@shared/agent-lab/telemetry';

const INSTRUMENTATION_SCOPE = 'restura.agent-lab';
const MAX_PENDING_DELIVERIES = 50;

export type TelemetryDeliveryStatus = 'disabled' | 'queued' | 'sent' | 'failed';

export interface TelemetryDelivery {
  id: string;
  status: TelemetryDeliveryStatus;
  error?: string;
}

export interface TelemetryPipeline {
  exportTrace(trace: TelemetryTrace): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AgentTelemetryServiceDependencies {
  createPipeline?: (config: AgentTelemetryConfig) => Promise<TelemetryPipeline>;
  resolveCredential?: (ref: TelemetryCredentialRef) => Promise<string>;
}

export function createAgentTelemetryService(dependencies: AgentTelemetryServiceDependencies = {}): {
  enqueue(trace: TelemetryTrace, config: AgentTelemetryConfig): TelemetryDelivery;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
} {
  const createPipeline =
    dependencies.createPipeline ??
    ((config: AgentTelemetryConfig) =>
      createNativeTelemetryPipeline(config, dependencies.resolveCredential));
  const pending = new Set<Promise<void>>();
  const pipelines = new Map<string, Promise<TelemetryPipeline>>();

  const track = (operation: Promise<void>): void => {
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };

  return {
    enqueue(trace, config) {
      const delivery: TelemetryDelivery = { id: trace.id, status: 'disabled' };
      if (!config.enabled || !isSampled(trace.id, config.sampleRate)) return delivery;
      if (pending.size >= MAX_PENDING_DELIVERIES) {
        delivery.status = 'failed';
        delivery.error = 'Telemetry delivery queue is full';
        return delivery;
      }
      delivery.status = 'queued';
      const key = JSON.stringify(config);
      const operation = (async (): Promise<void> => {
        try {
          let pipeline = pipelines.get(key);
          if (!pipeline) {
            pipeline = createPipeline(config);
            pipelines.set(key, pipeline);
          }
          const resolved = await pipeline;
          await resolved.exportTrace(trace);
          await resolved.flush();
          delivery.status = 'sent';
        } catch (error) {
          delivery.status = 'failed';
          delivery.error = error instanceof Error ? error.message : 'Telemetry export failed';
        }
      })();
      track(operation);
      return delivery;
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
    async shutdown() {
      await Promise.allSettled([...pending]);
      await Promise.allSettled(
        [...pipelines.values()].map(async (pipeline) => (await pipeline).shutdown())
      );
    },
  };
}

async function createNativeTelemetryPipeline(
  config: AgentTelemetryConfig,
  credentialResolver = resolveEnvironmentCredential
): Promise<TelemetryPipeline> {
  const processor = await createSpanProcessor(config, credentialResolver);
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer(INSTRUMENTATION_SCOPE, '1');
  return {
    async exportTrace(trace) {
      emitTrace(tracer, trace);
    },
    async flush() {
      await provider.forceFlush();
    },
    async shutdown() {
      await provider.shutdown();
    },
  };
}

async function createSpanProcessor(
  config: AgentTelemetryConfig,
  credentialResolver: (ref: TelemetryCredentialRef) => Promise<string>
) {
  if (config.target === 'langfuse') {
    const [publicKey, secretKey] = await Promise.all([
      credentialResolver(config.publicKey),
      credentialResolver(config.secretKey),
    ]);
    return new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl: config.baseUrl,
      environment: config.environment,
      mediaUploadEnabled: false,
      shouldExportSpan: ({ otelSpan }) =>
        otelSpan.instrumentationScope.name === INSTRUMENTATION_SCOPE,
    });
  }
  const headers =
    config.auth.mode === 'bearer'
      ? { Authorization: `Bearer ${await credentialResolver(config.auth.token)}` }
      : undefined;
  return new BatchSpanProcessor(new OTLPTraceExporter({ url: config.endpoint, headers }));
}

async function resolveEnvironmentCredential(ref: TelemetryCredentialRef): Promise<string> {
  if (ref.source === 'env') {
    const value = process.env[ref.name];
    if (value) return value;
    throw new Error(`Telemetry credential environment variable is not set: ${ref.name}`);
  }
  throw new Error('SecretRef telemetry credentials require the Electron secret resolver');
}

function emitTrace(tracer: Tracer, telemetry: TelemetryTrace): void {
  const root = tracer.startSpan(
    `agent ${telemetry.agentId}`,
    { kind: SpanKind.INTERNAL, startTime: telemetry.startedAt },
    context.active()
  );
  root.setAttributes({
    'openinference.span.kind': 'AGENT',
    'agent.id': telemetry.agentId,
    'eval.suite.id': telemetry.suiteId,
    'eval.task.id': telemetry.taskId,
    'eval.trial': telemetry.trial,
  });
  const parent = otelTrace.setSpan(context.active(), root);
  for (const event of telemetry.events) emitEvent(tracer, event, parent);
  root.end(telemetry.finishedAt ?? telemetry.startedAt);
}

function emitEvent(
  tracer: Tracer,
  event: TelemetryTraceEvent,
  parent: ReturnType<typeof otelTrace.setSpan>
): void {
  if (event.type === 'run.completed') return;
  const isModel = event.type === 'model.completed' || event.type === 'model.failed';
  const span: Span = tracer.startSpan(
    isModel ? `model ${event.model}` : `tool ${event.toolName}`,
    { kind: SpanKind.CLIENT, startTime: event.timestamp - event.durationMs },
    parent
  );
  if (isModel) {
    span.setAttributes({
      'openinference.span.kind': 'LLM',
      'gen_ai.system': event.providerId,
      'gen_ai.request.model': event.model,
      ...(event.type === 'model.failed' ? { 'error.type': 'model.failure' } : {}),
      ...(event.type === 'model.completed' && event.usage
        ? {
            'gen_ai.usage.input_tokens': event.usage.inputTokens,
            'gen_ai.usage.output_tokens': event.usage.outputTokens,
          }
        : {}),
    });
  } else {
    span.setAttributes({
      'openinference.span.kind': 'TOOL',
      'tool.name': event.toolName,
      ...(event.type === 'tool.failed' ? { 'error.type': 'tool.failure' } : {}),
    });
  }
  span.end(event.timestamp);
}

function isSampled(id: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff < sampleRate;
}
