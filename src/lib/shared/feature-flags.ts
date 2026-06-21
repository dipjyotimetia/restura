/**
 * Feature-flag client (Gap #7). Fetches once at boot, caches in memory with
 * a 5min TTL, fails open. Renderer gates protocol UIs via `useFlag(name)`.
 *
 * Failure posture: if the Worker is unreachable every flag reads as `true`
 * (empty `DEFAULT_FLAGS` + `getFlag`'s absent-is-true rule). A Worker outage
 * should never block the desktop app from doing its local work — kill-switches
 * are an incident-response tool, not a dependency.
 */

import { useEffect, useState } from 'react';
import { workerBaseUrl, workerAuthHeaders } from '@/lib/shared/platform';
import type { FeatureFlags } from '@shared/feature-flags-types';

export type { FeatureFlags };

const DEFAULT_FLAGS: FeatureFlags = {
  version: 0,
  asOf: new Date(0).toISOString(),
  flags: {},
};

const TTL_MS = 5 * 60 * 1000;
// Failure cache TTL is shorter so a transient blip doesn't lock the renderer
// into "all flags fail-open" for 5 minutes — kill-switches need to re-arm
// quickly once the Worker recovers.
const FAILURE_RETRY_MS = 30 * 1000;
let cached: { value: FeatureFlags; fetchedAt: number; failed?: boolean } | null = null;
let inflight: Promise<FeatureFlags> | null = null;

function isStale(now: number): boolean {
  if (!cached) return true;
  const ttl = cached.failed ? FAILURE_RETRY_MS : TTL_MS;
  return now - cached.fetchedAt >= ttl;
}

const listeners = new Set<() => void>();
function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* never let a listener break the rest */
    }
  }
}

export async function fetchFlags(): Promise<FeatureFlags> {
  if (cached && !isStale(Date.now())) return cached.value;
  if (inflight) return inflight;

  inflight = (async () => {
    const url = `${workerBaseUrl()}/api/feature-flags`;
    try {
      const res = await fetch(url, { headers: { ...workerAuthHeaders() } });
      if (!res.ok) throw new Error(`Flags returned ${res.status}`);
      const json = (await res.json()) as FeatureFlags;
      cached = { value: json, fetchedAt: Date.now() };
      notify();
      return json;
    } catch {
      cached = { value: DEFAULT_FLAGS, fetchedAt: Date.now(), failed: true };
      notify();
      return DEFAULT_FLAGS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Synchronous flag lookup. Returns `true` if flags haven't loaded yet or the
 * flag is absent — fail-open. Use `useFlag()` from React components to
 * re-render when flags arrive.
 */
export function getFlag(name: string): boolean {
  const flags = cached?.value.flags;
  if (!flags) return true;
  return flags[name] !== false;
}

export function useFlag(name: string): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => getFlag(name));
  useEffect(() => {
    const cb = (): void => setEnabled(getFlag(name));
    listeners.add(cb);
    void fetchFlags().then(cb);
    return () => {
      listeners.delete(cb);
    };
  }, [name]);
  return enabled;
}
