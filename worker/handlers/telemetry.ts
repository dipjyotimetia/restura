/**
 * `POST /api/telemetry/error` — opt-in renderer error sink. Validates the
 * payload shape, logs as JSON for Cloudflare tail, never stores. Rate limit
 * is inherited from the shared `/api/*` middleware chain. No-auth — telemetry
 * should land even when the user hasn't configured a proxy token (otherwise
 * we only learn about errors from authed users).
 */

import type { Context } from 'hono';
import { z } from 'zod';
import { parseJsonBody } from '../shared/validate-body';
import type { Env } from '../env';

const TelemetryErrorSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(8000).optional(),
  componentStack: z.string().max(4000).optional(),
  source: z.enum(['error-boundary', 'window-error', 'unhandled-rejection']),
  build: z.string().max(64),
  ua: z.string().max(256),
  ts: z.number().int().positive(),
});

export async function telemetryError(c: Context<{ Bindings: Env }>): Promise<Response> {
  // No-auth endpoint — cap the body well above the schema's own field limits
  // (~14 KB total) so an attacker can't stream a huge payload into memory
  // before validation rejects it.
  const parsed = await parseJsonBody(c.req.raw, TelemetryErrorSchema, { maxBytes: 64 * 1024 });
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const requestId = c.var.requestId;
  // Single-line JSON so `wrangler tail` and downstream log shippers can parse.
  console.log(JSON.stringify({ kind: 'telemetry.error', requestId, ...parsed.value }));
  return c.json({ ok: true, requestId }, 202);
}
