/**
 * Feature-flag (kill-switch) wire contract. Served by the Worker endpoint
 * (worker/handlers/feature-flags.ts) and consumed by the renderer client
 * (src/lib/shared/feature-flags.ts). Defined once here so the producer and
 * consumer can't drift. Bump `version` when the shape changes to invalidate
 * stale renderer caches.
 */

export interface FeatureFlags {
  version: number;
  asOf: string;
  flags: Record<string, boolean>;
}
