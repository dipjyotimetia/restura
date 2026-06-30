// Real IndexedDB-backed tests for ResturaDB. `fake-indexeddb/auto` installs an
// in-memory IndexedDB before the database module constructs its singleton, so
// these exercise the actual Dexie code paths (export/import/clear/stats) rather
// than a mock. The global test setup mocks `@/lib/shared/dexie-storage` (the
// adapter layer) but NOT `database.ts`, so importing `db` here is the real thing.
import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../database';

/** Tables that the old hand-listed export/import/stats silently dropped (added after schema v5). */
const PREVIOUSLY_OMITTED = [
  'console',
  'graphqlSchemas',
  'protoFiles',
  'aiChat',
  'globals',
  'aiLab',
  'evalRuns',
  'arenaRuns',
  'collectionRuns',
] as const;

const SAMPLE_TABLES = ['collections', 'environments', ...PREVIOUSLY_OMITTED] as const;

function rec(id: string) {
  return { id, name: id, updatedAt: 1, encryptedData: `enc:${id}` };
}

describe('ResturaDB backup/export/import/stats', () => {
  beforeEach(async () => {
    await db.clearAllData();
  });

  afterAll(async () => {
    await db.delete();
  });

  it('exportAllData covers every data table (including those added after v5) and excludes metadata', async () => {
    for (const t of SAMPLE_TABLES) await db.table(t).put(rec(`${t}-1`));
    // A row in the internal KV table must NOT appear in a user data backup.
    await db.metadata.put({ key: 'quarantine:should-not-export', value: 'x' });

    const exported = await db.exportAllData();

    // Every data table the schema declares appears as a key.
    const dataTableNames = db.tables.map((t) => t.name).filter((n) => n !== 'metadata');
    for (const name of dataTableNames) {
      expect(exported.data).toHaveProperty(name);
    }
    // ...specifically including each table the pre-fix export dropped on the floor.
    for (const t of PREVIOUSLY_OMITTED) {
      expect(exported.data[t]).toEqual([rec(`${t}-1`)]);
    }
    expect(exported.data).not.toHaveProperty('metadata');
    expect(exported.version).toBe(6);
  });

  it('round-trips: export → clear → import restores every table', async () => {
    for (const t of SAMPLE_TABLES) await db.table(t).put(rec(`${t}-1`));
    const exported = await db.exportAllData();

    await db.clearAllData();
    for (const t of SAMPLE_TABLES) expect(await db.table(t).count()).toBe(0);

    await db.importAllData(exported);
    for (const t of SAMPLE_TABLES) {
      expect(await db.table(t).get(`${t}-1`)).toEqual(rec(`${t}-1`));
    }
  });

  it('getStorageStats counts every data table including the formerly-omitted ones', async () => {
    await db.table('collections').put(rec('c1'));
    await db.table('globals').put(rec('g1'));
    await db.table('collectionRuns').put(rec('r1'));

    const stats = await db.getStorageStats();
    expect(stats.tables).toHaveProperty('globals', 1);
    expect(stats.tables).toHaveProperty('collectionRuns', 1);
    expect(stats.tables).not.toHaveProperty('metadata');
    expect(stats.totalRecords).toBe(3);
  });

  it('importAllData stays backward-compatible with a pre-v6 backup subset', async () => {
    // Old backups carried only a few tables; import must restore them, ignore
    // absent tables, and not throw.
    await db.importAllData({ version: 5, data: { collections: [rec('old-1')] } });
    expect(await db.table('collections').get('old-1')).toEqual(rec('old-1'));
    expect(await db.table('globals').count()).toBe(0);
  });

  it('clearAllData empties data tables and the internal metadata table', async () => {
    await db.table('collections').put(rec('c1'));
    await db.metadata.put({ key: 'm', value: 'v' });

    await db.clearAllData();

    expect(await db.table('collections').count()).toBe(0);
    expect(await db.metadata.count()).toBe(0);
  });
});
