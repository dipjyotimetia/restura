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

  // Parity with the app's `Papa.parse(text, { header: true, skipEmptyLines: true })`.
  it.each([
    ['semicolon', 'name;city\nAlice;Sydney\n'],
    ['tab', 'name\tcity\nAlice\tSydney\n'],
    ['pipe', 'name|city\nAlice|Sydney\n'],
  ])('detects a %s-delimited CSV like the app', async (_label, text) => {
    const file = join(dir, 'rows.csv');
    await writeFile(file, text);
    expect(await loadIterationData(file)).toEqual([{ name: 'Alice', city: 'Sydney' }]);
  });

  it('ignores delimiters inside quoted header fields', async () => {
    const file = join(dir, 'rows.csv');
    await writeFile(file, '"a;b",c\n"x;y",z\n');
    expect(await loadIterationData(file)).toEqual([{ 'a;b': 'x;y', c: 'z' }]);
  });

  it('keeps surrounding whitespace in values, as the app does', async () => {
    const file = join(dir, 'rows.csv');
    await writeFile(file, 'name,token\nAlice,  padded \n');
    expect(await loadIterationData(file)).toEqual([{ name: 'Alice', token: '  padded ' }]);
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

  it('errors on an empty JSON array instead of running one row-less iteration', async () => {
    const file = join(dir, 'empty.json');
    await writeFile(file, '[]');
    await expect(loadIterationData(file)).rejects.toThrow(/no rows/);
  });

  it('errors on a header-only CSV', async () => {
    const file = join(dir, 'h.csv');
    await writeFile(file, 'name,city\n');
    await expect(loadIterationData(file)).rejects.toThrow(/no rows/);
  });

  it('sniffs JSON in a file with a non-json extension (as the app does)', async () => {
    const file = join(dir, 'rows.txt');
    await writeFile(file, '  [{"a": 1}]');
    expect(await loadIterationData(file)).toEqual([{ a: '1' }]);
  });

  it('reads a non-json extension as CSV when it does not start with [', async () => {
    const file = join(dir, 'rows.txt');
    await writeFile(file, 'a,b\n1,2\n');
    expect(await loadIterationData(file)).toEqual([{ a: '1', b: '2' }]);
  });

  it('refuses a ragged CSV row with a message naming the file (the app refuses it too)', async () => {
    const file = join(dir, 'ragged.csv');
    await writeFile(file, 'a,b\n1\n');
    await expect(loadIterationData(file)).rejects.toThrow(/ragged\.csv/);
  });

  it('rejects JSON files that are not arrays', async () => {
    const file = join(dir, 'rows.json');
    await writeFile(file, JSON.stringify({ not: 'an array' }));
    await expect(loadIterationData(file)).rejects.toThrow(/array of objects/);
  });
});
