import { describe, it, expect } from 'vitest';
import { zipEntries, unzipToEntries } from '../zip-utils';

async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function sortByPath<T extends { relativePath: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

describe('zip-utils', () => {
  it('round-trips a list of text entries through zip and unzip', async () => {
    const entries = [
      { relativePath: 'bruno.json', content: '{"version":"1"}' },
      { relativePath: 'get-user.bru', content: 'meta { name: Get User }' },
      { relativePath: 'environments/dev.bru', content: 'vars { host: localhost }' },
    ];

    const blob = await zipEntries(entries);
    const unzipped = await unzipToEntries(await blobToUint8Array(blob));

    expect(sortByPath(unzipped)).toEqual(sortByPath(entries));
  });

  it('produces a valid empty zip for an empty entries array', async () => {
    const blob = await zipEntries([]);
    const unzipped = await unzipToEntries(await blobToUint8Array(blob));
    expect(unzipped).toEqual([]);
  });

  it('preserves nested relative paths', async () => {
    const entries = [{ relativePath: 'folder/nested/request.bru', content: 'get { url: / }' }];
    const blob = await zipEntries(entries);
    const unzipped = await unzipToEntries(await blobToUint8Array(blob));
    expect(unzipped).toEqual(entries);
  });
});
