import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIterationData } from '../dataLoader';

describe('loadIterationData', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restura-data-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns [] when no path is given', async () => {
    expect(await loadIterationData(undefined)).toEqual([]);
  });

  it('loads CSV with a header row', async () => {
    const file = join(dir, 'rows.csv');
    await writeFile(file, 'name,city\nAlice,Sydney\nBob,Melbourne\n');
    const rows = await loadIterationData(file);
    expect(rows).toEqual([
      { name: 'Alice', city: 'Sydney' },
      { name: 'Bob', city: 'Melbourne' },
    ]);
  });

  it('loads JSON arrays of objects', async () => {
    const file = join(dir, 'rows.json');
    await writeFile(
      file,
      JSON.stringify([
        { a: 1, b: 'two' },
        { a: 2, b: 'three' },
      ])
    );
    const rows = await loadIterationData(file);
    expect(rows).toEqual([
      { a: '1', b: 'two' },
      { a: '2', b: 'three' },
    ]);
  });

  it('rejects JSON files that are not arrays', async () => {
    const file = join(dir, 'rows.json');
    await writeFile(file, JSON.stringify({ not: 'an array' }));
    await expect(loadIterationData(file)).rejects.toThrow(/array of objects/);
  });
});
