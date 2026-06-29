import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { scanCollection } from '../../src/workspace/collectionScanner';
import { resultKey, toRelativePath } from '../../src/offering2_test/cliResult';
import { classifyOutcome } from '../../src/offering2_test/outcome';
import type { CliRequestRunResult } from '../../src/offering2_test/cliResult';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'sample-collection'
);

function makeResult(over: Partial<CliRequestRunResult>): CliRequestRunResult {
  return {
    request: { request: { name: 'r' }, folderPath: [], relativePath: 'r', type: 'http' },
    status: 200,
    passed: true,
    durationMs: 12,
    bodyBytes: 0,
    ...over,
  };
}

describe('scanCollection', () => {
  it('discovers runnable requests from the fixture collection', async () => {
    const reqs = await scanCollection(FIXTURE);
    const names = reqs.map((r) => r.name).sort();
    // get-anything.yaml (valid http) + broken-request.yaml (still a request file).
    expect(names).toContain('Get anything');
    expect(names).toContain('Broken request');
    // All discovered entries are root-level (no folders in the fixture).
    expect(reqs.every((r) => r.folderPath.length === 0)).toBe(true);
  });

  it('returns [] for a directory without an opencollection root', async () => {
    expect(await scanCollection(join(FIXTURE, '..'))).toEqual([]);
  });
});

describe('resultKey', () => {
  it('is stable across discovery and result sides', () => {
    expect(resultKey(['users'], 'Get user')).toBe(resultKey(['users'], 'Get user'));
    expect(resultKey([], 'A')).not.toBe(resultKey(['A'], ''));
  });
});

describe('toRelativePath', () => {
  it('mirrors the CLI: folder path joined with name', () => {
    expect(toRelativePath(['users'], 'Get user')).toBe('users/Get user');
    expect(toRelativePath(['a', 'b'], 'c')).toBe('a/b/c');
  });

  it('falls back to the bare name at the root (matches CLI || name)', () => {
    expect(toRelativePath([], 'List posts')).toBe('List posts');
  });
});

describe('classifyOutcome', () => {
  it('maps passed', () => {
    expect(classifyOutcome(makeResult({ passed: true })).kind).toBe('passed');
  });

  it('maps transport errors to errored', () => {
    const o = classifyOutcome(
      makeResult({ passed: false, status: 0, errorMessage: 'getaddrinfo ENOTFOUND' })
    );
    expect(o.kind).toBe('errored');
    if (o.kind === 'errored') expect(o.message).toContain('ENOTFOUND');
  });

  it('maps assertion failures to failed with details', () => {
    const o = classifyOutcome(
      makeResult({
        passed: false,
        status: 200,
        assertions: [
          { name: 'status is 200', passed: true },
          { name: 'has id', passed: false, error: 'expected id' },
        ],
      })
    );
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.message).toContain('has id');
  });

  it('falls back to HTTP status when a non-passing result has no assertions', () => {
    const o = classifyOutcome(makeResult({ passed: false, status: 500 }));
    expect(o.kind).toBe('failed');
    if (o.kind === 'failed') expect(o.message).toContain('500');
  });
});
