import { z } from 'zod';

/**
 * Telemetry configuration for agent evaluation traces.
 *
 * Disabled by default — no telemetry is transmitted without explicit opt-in
 * and destination-specific confirmation.
 */
export const AgentTelemetryConfigSchema = z
  .object({
    /** OTLP/HTTP endpoint URL (e.g. https://api.console.anthropic.com/v1/otlp). */
    endpoint: z.string().url(),
    /** Optional authentication via a named environment variable containing a Bearer token. */
    auth: z
      .object({
        kind: z.literal('env'),
        name: z.string().min(1).max(200),
      })
      .optional(),
    /** Deployment environment label (e.g. "production", "ci", "staging"). */
    environment: z.string().min(1).max(100).default('production'),
    /**
     * Sampling rate (0.0–1.0). 1.0 = export every trace, 0.0 = export nothing.
     * Defaults to 1.0 when the exporter is enabled.
     */
    sampleRate: z.number().min(0).max(1).default(1),
    /**
     * Data content policy. Controls what detail is included in telemetry
     * payloads. Defaults to "metadata-only" — run metadata, durations, models,
     * token/cost values, tool names, approval outcomes, and verdicts, but NOT
     * prompt text, raw bodies, credentials, query values, or opaque tool output.
     */
    dataContent: z.enum(['metadata-only', 'enriched']).default('metadata-only'),
  })
  .strict();

export type AgentTelemetryConfig = z.infer<typeof AgentTelemetryConfigSchema>;

/** No-op sentinel used when telemetry is disabled. */
export const TELEMETRY_DISABLED = Symbol('telemetry-disabled');

export type AgentTelemetryConfigOrDisabled =
  | { kind: 'disabled' }
  | { kind: 'enabled'; config: AgentTelemetryConfig };

/**
 * Normalise a raw (possibly partial) config into a canonical state.
 * Returns `{ kind: 'disabled' }` when the input is undefined, null, or
 * has no `endpoint` — the only required field.
 */
export function normaliseAgentTelemetryConfig(
  input: unknown
): AgentTelemetryConfigOrDisabled {
  if (!input || typeof input !== 'object') return { kind: 'disabled' };
  const candidate = input as Record<string, unknown>;
  if (!candidate['endpoint'] || typeof candidate['endpoint'] !== 'string') {
    return { kind: 'disabled' };
  }
  const parsed = AgentTelemetryConfigSchema.safeParse(candidate);
  if (!parsed.success) return { kind: 'disabled' };
  return { kind: 'enabled', config: parsed.data };
}