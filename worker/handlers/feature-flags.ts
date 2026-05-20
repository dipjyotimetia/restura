/**
 * `GET /api/feature-flags` — public, unauthenticated kill-switch endpoint
 * (Gap #7). Renderer fetches once at boot, caches in memory, gates each
 * protocol's UI based on the response. Fails open if unreachable (a Worker
 * outage should never disable the desktop app's local capabilities).
 *
 * v1: hardcoded JSON. v2 (not in this rollout): KV-backed with a tiny admin
 * UI. Bump `version` when the flag shape changes to invalidate stale caches.
 */

import type { Context } from 'hono';
import type { Env } from '../index';

export interface FeatureFlags {
  version: number;
  asOf: string;
  flags: Record<string, boolean>;
}

const FLAGS: FeatureFlags = {
  version: 1,
  asOf: '2026-05-20T00:00:00Z',
  flags: {
    'protocol.http': true,
    'protocol.grpc': true,
    'protocol.graphql': true,
    'protocol.websocket': true,
    'protocol.sse': true,
    'protocol.mcp': true,
    'protocol.kafka': true,
    'protocol.socketio': true,
  },
};

export async function featureFlags(c: Context<{ Bindings: Env }>): Promise<Response> {
  // Cache for 5 minutes at the edge to keep cold-isolate latency negligible.
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
  return c.json(FLAGS);
}
