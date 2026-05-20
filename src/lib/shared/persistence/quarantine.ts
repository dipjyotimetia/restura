/**
 * Quarantine raw persisted state when a migration fails (Gap #6). Pre-1.0,
 * user data is still recoverable — better than silently dropping. Records
 * land in the existing `metadata` Dexie table keyed by quarantine path; the
 * Diagnostics panel surfaces them with download-as-JSON + retry buttons.
 *
 * LRU cap at 50 entries so a malformed-state loop can't fill IndexedDB.
 */

import { db } from '@/lib/shared/database';

const MAX_QUARANTINE_ENTRIES = 50;
const QUARANTINE_PREFIX = 'quarantine:';

export async function quarantineState(
  key: string,
  raw: unknown,
  reason: string,
): Promise<void> {
  try {
    await db.transaction('rw', db.metadata, async () => {
      const existing = await db.metadata
        .filter((m) => m.key.startsWith(QUARANTINE_PREFIX))
        .toArray();
      if (existing.length >= MAX_QUARANTINE_ENTRIES) {
        // Drop the oldest (lexicographically first ISO-timestamped key).
        const sorted = existing.sort((a, b) => a.key.localeCompare(b.key));
        const overflow = sorted.length - MAX_QUARANTINE_ENTRIES + 1;
        for (let i = 0; i < overflow; i++) {
          const oldKey = sorted[i]?.key;
          if (oldKey) await db.metadata.delete(oldKey);
        }
      }
      await db.metadata.put({
        key,
        value: JSON.stringify({ reason, ts: Date.now(), raw }),
      });
    });
  } catch (err) {
    // Quarantine MUST NOT throw — caller is in the middle of zustand rehydrate.
    console.error('[persistence] quarantine write failed:', err);
  }
}

export async function listQuarantined(): Promise<Array<{ key: string; reason: string; ts: number }>> {
  try {
    const rows = await db.metadata
      .filter((m) => m.key.startsWith(QUARANTINE_PREFIX))
      .toArray();
    return rows.map((r) => {
      try {
        const parsed = JSON.parse(r.value) as { reason?: string; ts?: number };
        return { key: r.key, reason: parsed.reason ?? 'unknown', ts: parsed.ts ?? 0 };
      } catch {
        return { key: r.key, reason: 'unreadable', ts: 0 };
      }
    });
  } catch {
    return [];
  }
}
