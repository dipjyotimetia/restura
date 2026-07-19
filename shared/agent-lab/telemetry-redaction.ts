import type { Trace, TraceEvent } from './types';

/**
 * Data content policy for agent telemetry.
 */
export type DataContentPolicy = 'metadata-only' | 'enriched';

/**
 * Redacted trace payload — a privacy-scoped subset of the original Trace.
 * Only fields listed in the allowlist survive. No prompt text, raw bodies,
 * credentials, query values, or opaque tool output.
 */
export interface RedactedTrace {
  id: string;
  suiteId: string;
  taskId: string;
  trial: number;
  agentId: string;
  startedAt: number;
  finishedAt?: number;
  events: RedactedTraceEvent[];
}

export type RedactedTraceEvent =
  | { type: 'run.started'; agentId: string; timestamp: number }
  | { type: 'run.completed'; status: 'passed' | 'failed' | 'error' | 'cancelled'; timestamp: number }
  | {
      type: 'context.retrieved';
      sourceId: string;
      kind: string;
      bytes: number;
      truncated: boolean;
      timestamp: number;
    }
  | {
      type: 'policy.decision';
      subject: string;
      decision: 'allowed' | 'denied';
      reason: string;
      timestamp: number;
    }
  | {
      type: 'model.requested';
      providerId: string;
      model: string;
      timestamp: number;
      /** Only present in 'enriched' mode. */
      input?: unknown;
    }
  | {
      type: 'model.completed';
      providerId: string;
      model: string;
      durationMs: number;
      timestamp: number;
      usage?: { inputTokens: number; outputTokens: number };
      costUSD?: number;
    }
  | {
      type: 'model.failed';
      providerId: string;
      model: string;
      durationMs: number;
      timestamp: number;
      /** Error message is included as it's needed for diagnostics; it should not
       * contain credentials (providers are expected to redact their own errors). */
      error: string;
    }
  | {
      type: 'tool.requested';
      toolCallId: string;
      toolName: string;
      permissionClass: string;
      timestamp: number;
    }
  | {
      type: 'tool.completed';
      toolCallId: string;
      toolName: string;
      durationMs: number;
      timestamp: number;
    }
  | {
      type: 'tool.failed';
      toolCallId: string;
      toolName: string;
      durationMs: number;
      timestamp: number;
      error: string;
    }
  | {
      type: 'approval.requested';
      approvalId: string;
      toolCallId: string;
      permissionClass: string;
      timestamp: number;
    }
  | {
      type: 'approval.resolved';
      approvalId: string;
      decision: 'approved' | 'denied';
      timestamp: number;
    }
  | {
      type: 'handoff';
      fromAgentId: string;
      toAgentId: string;
      timestamp: number;
    };

/**
 * Redact a Trace to a privacy-scoped subset.
 *
 * In `metadata-only` mode (default):
 *  - model.requested input is stripped
 *  - model.completed output is stripped
 *  - tool.completed output is stripped
 *  - tool.requested arguments are stripped
 *  - tool.failed output is stripped
 *
 * In `enriched` mode:
 *  - model.requested input shape is preserved (counts, types, but still no
 *    raw credentials — the existing redaction layer is expected to have run
 *    before the trace is emitted)
 *  - tool output is still stripped (tool output is opaque and may contain
 *    PII, credentials, or internal state)
 */
export function redactTrace(
  trace: Trace,
  policy: DataContentPolicy = 'metadata-only'
): RedactedTrace {
  return {
    id: trace.id,
    suiteId: trace.suiteId,
    taskId: trace.taskId,
    trial: trace.trial,
    agentId: trace.agentId,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    events: trace.events.map((event) => redactTraceEvent(event, policy)),
  };
}

function redactTraceEvent(
  event: TraceEvent,
  policy: DataContentPolicy
): RedactedTraceEvent {
  switch (event.type) {
    case 'run.started':
      return { type: 'run.started', agentId: event.agentId, timestamp: event.timestamp };
    case 'run.completed':
      return { type: 'run.completed', status: event.status, timestamp: event.timestamp };
    case 'context.retrieved':
      return {
        type: 'context.retrieved',
        sourceId: event.sourceId,
        kind: event.kind,
        bytes: event.bytes,
        truncated: event.truncated,
        timestamp: event.timestamp,
      };
    case 'policy.decision':
      return {
        type: 'policy.decision',
        subject: event.subject,
        decision: event.decision,
        reason: event.reason,
        timestamp: event.timestamp,
      };
    case 'model.requested':
      return {
        type: 'model.requested',
        providerId: event.providerId,
        model: event.model,
        timestamp: event.timestamp,
        ...(policy === 'enriched' ? { input: event.input } : {}),
      };
    case 'model.completed':
      return {
        type: 'model.completed',
        providerId: event.providerId,
        model: event.model,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
        usage: event.usage,
        costUSD: event.costUSD,
      };
    case 'model.failed':
      return {
        type: 'model.failed',
        providerId: event.providerId,
        model: event.model,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
        error: event.error,
      };
    case 'tool.requested':
      return {
        type: 'tool.requested',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        permissionClass: event.permissionClass,
        timestamp: event.timestamp,
      };
    case 'tool.completed':
      return {
        type: 'tool.completed',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
      };
    case 'tool.failed':
      return {
        type: 'tool.failed',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        timestamp: event.timestamp,
        error: event.error,
      };
    case 'approval.requested':
      return {
        type: 'approval.requested',
        approvalId: event.approvalId,
        toolCallId: event.toolCallId,
        permissionClass: event.permissionClass,
        timestamp: event.timestamp,
      };
    case 'approval.resolved':
      return {
        type: 'approval.resolved',
        approvalId: event.approvalId,
        decision: event.decision,
        timestamp: event.timestamp,
      };
    case 'handoff':
      return {
        type: 'handoff',
        fromAgentId: event.fromAgentId,
        toAgentId: event.toAgentId,
      };
  }
}