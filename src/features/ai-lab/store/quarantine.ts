// Per-record recovery for persisted AI Lab stores. A single record that fails
// validation used to reset the WHOLE store (providers, datasets, eval configs,
// run history…). Instead we drop only the offenders, keep everything else, and
// save the raw invalid data under a sibling quarantine key so nothing is lost —
// the user is offered an export of that backup.
import { toast } from 'sonner';
import type { z } from 'zod';
import { getDexieStorageItemStrict, setDexieStorageItemStrict } from '@/lib/shared/dexie-storage';
import { downloadBlob } from '@/lib/shared/file-utils';

type QuarantineTable = 'aiLab' | 'evalRuns' | 'arenaRuns';

export interface RecordPartition {
  /** Original (unparsed) values that passed validation — the schema strips unknown keys. */
  valid: Record<string, unknown>;
  /** Original values that failed validation, keyed by record id. */
  invalid: Record<string, unknown>;
}

/** Validate a `Record<id, value>` entry by entry; one bad record never taints its siblings. */
export function partitionRecords(raw: unknown, schema: z.ZodType): RecordPartition {
  const valid: Record<string, unknown> = {};
  const invalid: Record<string, unknown> = {};
  if (raw === undefined || raw === null) return { valid, invalid };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    invalid['(root)'] = raw; // the container itself is malformed — keep it for export
    return { valid, invalid };
  }
  for (const [id, value] of Object.entries(raw)) {
    if (schema.safeParse(value).success) valid[id] = value;
    else invalid[id] = value;
  }
  return { valid, invalid };
}

export function hasQuarantinedData(blob: Record<string, unknown>): boolean {
  return Object.values(blob).some(
    (section) =>
      section !== null && (typeof section !== 'object' || Object.keys(section as object).length > 0)
  );
}

/**
 * Content-addressed backup key. The invalid data stays in the live store until
 * its next write, so every launch re-quarantines the SAME blob; a fixed key per
 * content makes that an overwrite instead of one more backup row per launch.
 */
async function backupKey(storeName: string, json: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${storeName}__invalid-${hex.slice(0, 16)}`;
}

/**
 * Save `blob` next to the live store key and tell the user. Best-effort: a
 * failed backup write must not break hydration, but it is surfaced in the toast.
 */
export function quarantineInvalid(
  table: QuarantineTable,
  storeName: string,
  label: string,
  blob: Record<string, unknown>
): Promise<void> {
  if (!hasQuarantinedData(blob)) return Promise.resolve();
  const count = Object.values(blob).reduce<number>(
    (sum, section) =>
      sum + (section && typeof section === 'object' ? Object.keys(section).length : 1),
    0
  );
  const saved = backupKey(storeName, JSON.stringify(blob))
    .then(async (key) => {
      // Skip the write when this exact backup is already stored.
      const existing = await getDexieStorageItemStrict(table, key).catch(() => null);
      if (existing === null) await setDexieStorageItemStrict(table, key, blob);
      console.warn(`[ai-lab] quarantined ${count} invalid ${label} record(s) to "${key}"`);
    })
    .then(
      () => true,
      () => false
    );
  return saved.then((ok) => {
    // The Toaster may not be mounted while the store hydrates at import time.
    setTimeout(() => {
      toast.warning(`${count} invalid ${label} record${count === 1 ? ' was' : 's were'} removed`, {
        description: ok
          ? 'A backup copy was kept. Use Export backup to save it as a file; the app cannot restore it for you.'
          : 'The backup could not be saved. Export it now before closing the app.',
        duration: 15_000,
        action: {
          label: 'Export backup',
          onClick: () =>
            downloadBlob(JSON.stringify(blob, null, 2), `restura-ai-lab-${storeName}-invalid.json`),
        },
      });
    }, 1500);
  });
}
