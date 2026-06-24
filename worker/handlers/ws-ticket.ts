/**
 * `POST /api/ws-ticket` — one-shot ticket exchange so browser WebSocket
 * (which can't set headers) can still proxy through the Worker with custom
 * headers / protocols (Gap #5).
 *
 * Flow: client POSTs `{ target, headers?, protocols? }` → Worker validates
 * the target via the shared SSRF gate, stashes the spec in a TTL-bounded
 * in-isolate `Map`, returns `{ ticket, expiresAt }`. Client opens
 * `wss://api/.../ws?ticket=<id>`. Ticket is single-use and expires in 30s.
 *
 * KNOWN LIMITATION: the ticket Map is per-isolate. Cloudflare can route the
 * POST and the subsequent GET to different isolates, in which case the
 * ticket appears unknown. Acceptable for low-volume first cut; move to
 * Workers KV (or a Durable Object) before this sees real load. Tracked.
 */

import { validateWsUrl } from '@shared/protocol/websocket-proxy';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { allowPrivateIPs, isLocalDevBypass } from '../shared/env';
import { parseJsonBody } from '../shared/validate-body';

interface TicketEntry {
  target: string;
  headers?: Record<string, string>;
  protocols?: string[];
  expiresAt: number;
}

const TICKET_TTL_MS = 30_000;
const GC_SIZE_THRESHOLD = 64;
const GC_INTERVAL_MS = 1_000;
const tickets = new Map<string, TicketEntry>();
let lastGcAt = 0;

function gcTickets(now: number): void {
  if (tickets.size < GC_SIZE_THRESHOLD || now - lastGcAt < GC_INTERVAL_MS) return;
  lastGcAt = now;
  for (const [id, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(id);
  }
}

const TicketRequestSchema = z.object({
  target: z.string().min(1).max(2048),
  // Bound key length and total count — z.record has no native count cap, so
  // refine guards against a payload with a huge number of header keys.
  headers: z
    .record(z.string().max(256), z.string().max(8192))
    .refine((h) => Object.keys(h).length <= 64, { message: 'Too many headers (max 64)' })
    .optional(),
  protocols: z.array(z.string().max(64)).max(8).optional(),
});

export async function wsTicket(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Small request shape; cap the body so a giant payload can't be buffered
  // before validation. 256 KB leaves headroom for max headers/protocols.
  const parsed = await parseJsonBody(c.req.raw, TicketRequestSchema, { maxBytes: 256 * 1024 });
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const validation = validateWsUrl(parsed.value.target, {
    allowLocalhost: isLocalDevBypass(c.env),
    allowPrivateIPs: allowPrivateIPs(c.env),
  });
  if (!validation.ok) {
    return c.json({ error: `Invalid target: ${validation.error}` }, 400);
  }

  const now = Date.now();
  gcTickets(now);
  const ticket = crypto.randomUUID();
  const entry: TicketEntry = {
    target: parsed.value.target,
    expiresAt: now + TICKET_TTL_MS,
    ...(parsed.value.headers ? { headers: parsed.value.headers } : {}),
    ...(parsed.value.protocols ? { protocols: parsed.value.protocols } : {}),
  };
  tickets.set(ticket, entry);
  return c.json({ ticket, expiresAt: entry.expiresAt });
}

/** Single-use consume; returns null if ticket is unknown or expired. */
export function consumeTicket(id: string): TicketEntry | null {
  const entry = tickets.get(id);
  if (!entry) return null;
  tickets.delete(id);
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}
