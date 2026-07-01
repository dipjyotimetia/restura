/**
 * Zip/unzip a flat list of `{relativePath, content}` text entries — the
 * shape both `bruno-exporter.ts`'s directory output and `importBrunoCollection`'s
 * directory-mode input already use. `fflate` is loaded lazily (dynamic
 * import) so its ~8KB isn't paid by renderers that never touch Bruno
 * import/export, mirroring `bruno-lang.ts`'s `loadBrunoLang()` convention.
 */

export interface ZipTextEntry {
  relativePath: string;
  content: string;
}

export async function zipEntries(entries: ZipTextEntry[]): Promise<Blob> {
  const { zipSync, strToU8 } = await import('fflate');
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    files[entry.relativePath] = strToU8(entry.content);
  }
  const zipped = zipSync(files);
  return new Blob([zipped as BlobPart], { type: 'application/zip' });
}

export async function unzipToEntries(bytes: Uint8Array): Promise<ZipTextEntry[]> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const unzipped = unzipSync(bytes);
  const entries: ZipTextEntry[] = [];
  for (const [relativePath, data] of Object.entries(unzipped)) {
    if (relativePath.endsWith('/')) continue; // directory entry, no content
    if (relativePath.startsWith('__MACOSX/') || relativePath.endsWith('.DS_Store')) continue;
    entries.push({ relativePath, content: strFromU8(data) });
  }
  return entries;
}
