import { context, SpanKind, trace as otelTrace } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  projectTraceForTelemetry,
  type AgentSuiteReport,
  type AgentTelemetryConfig,
  type TelemetryTrace,
} from '@shared/agent-lab';

const SCOPE = 'restura.agent-lab';

export async function exportCliAgentTelemetry(
  report: AgentSuiteReport,
  config: AgentTelemetryConfig,
  environment: Readonly<Record<string, string | undefined>>
): Promise<void> {
  if (!config.enabled) return;
  const resolve = (
    ref: { source: 'env'; name: string } | { source: 'secret-handle'; id: string }
  ) => {
    if (ref.source !== 'env')
      throw new Error('CLI telemetry credentials must use environment references');
    const value = environment[ref.name];
    if (!value)
      throw new Error(`Telemetry credential environment variable is not set: ${ref.name}`);
    return value;
  };
  const processor =
    config.target === 'langfuse'
      ? new LangfuseSpanProcessor({
          publicKey: resolve(config.publicKey),
          secretKey: resolve(config.secretKey),
          baseUrl: config.baseUrl,
          environment: config.environment,
          mediaUploadEnabled: false,
          shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === SCOPE,
        })
      : new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: config.endpoint,
            ...(config.auth.mode === 'bearer'
              ? { headers: { Authorization: `Bearer ${resolve(config.auth.token)}` } }
              : {}),
          })
        );
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer(SCOPE, '1');
  try {
    for (const result of report.results) emitTrace(tracer, projectTraceForTelemetry(result.trace));
    await provider.forceFlush();
  } finally {
    await provider.shutdown();
  }
}

function emitTrace(
  tracer: ReturnType<NodeTracerProvider['getTracer']>,
  trace: TelemetryTrace
): void {
  const root = tracer.startSpan(`agent ${trace.agentId}`, {
    kind: SpanKind.INTERNAL,
    startTime: trace.startedAt,
  });
  root.setAttributes({
    'openinference.span.kind': 'AGENT',
    'agent.id': trace.agentId,
    'eval.suite.id': trace.suiteId,
    'eval.task.id': trace.taskId,
    'eval.trial': trace.trial,
  });
  const parent = otelTrace.setSpan(context.active(), root);
  for (const event of trace.events) {
    if (
      event.type !== 'model.completed' &&
      event.type !== 'model.failed' &&
      event.type !== 'tool.completed' &&
      event.type !== 'tool.failed'
    )
      continue;
    const model = event.type === 'model.completed' || event.type === 'model.failed';
    const span = tracer.startSpan(
      model ? `model ${event.model}` : `tool ${event.toolName}`,
      { kind: SpanKind.CLIENT, startTime: event.timestamp - event.durationMs },
      parent
    );
    span.setAttributes(
      model
        ? {
            'openinference.span.kind': 'LLM',
            'gen_ai.system': event.providerId,
            'gen_ai.request.model': event.model,
            ...(event.type === 'model.completed' && event.usage
              ? {
                  'gen_ai.usage.input_tokens': event.usage.inputTokens,
                  'gen_ai.usage.output_tokens': event.usage.outputTokens,
                }
              : {}),
          }
        : { 'openinference.span.kind': 'TOOL', 'tool.name': event.toolName }
    );
    span.end(event.timestamp);
  }
  root.end(trace.finishedAt ?? trace.startedAt);
}
