/**
 * Writes a Bruno `.bru` export (the flat `{relativePath, content}[]` shape
 * produced by `bruno-exporter.ts`) to a directory on disk. Kept separate from
 * `collection-manager.ts` — that file owns Restura's own `.rq.yaml`/`.grq.yaml`
 * schema; this one owns an unrelated third-party text format.
 */

import { ipcMain } from 'electron';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createValidatedHandler, FilePathSchema } from '../ipc/ipc-validators';
import { isPathSafe } from './file-operations';

export interface BrunoExportEntry {
  relativePath: string;
  content: string;
}

const BrunoExportEntrySchema = z.object({
  relativePath: z.string().min(1).max(1024),
  content: z.string().max(50 * 1024 * 1024),
});

const SaveBrunoDirectorySchema = z.tuple([z.array(BrunoExportEntrySchema), FilePathSchema]);

export async function saveBrunoEntriesToDirectory(
  directoryPath: string,
  entries: BrunoExportEntry[]
): Promise<{ success: boolean; error?: string }> {
  if (!isPathSafe(directoryPath)) {
    return { success: false, error: 'Access denied: Path is outside allowed directories' };
  }

  const root = path.resolve(directoryPath);
  // isPathSafe only validates the root — nothing else stops a malformed
  // relativePath (e.g. `../../etc/whatever`) from escaping it during the
  // write loop below, since these paths come from the renderer's exporter
  // output rather than a trusted on-disk walk.
  for (const entry of entries) {
    const resolved = path.resolve(root, entry.relativePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return {
        success: false,
        error: `Refusing to write outside target directory: ${entry.relativePath}`,
      };
    }
  }

  await fsp.mkdir(root, { recursive: true });
  await Promise.all(
    entries.map(async (entry) => {
      const dest = path.resolve(root, entry.relativePath);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, entry.content, 'utf-8');
    })
  );

  return { success: true };
}

export function registerBrunoExportHandlerIPC(): void {
  ipcMain.handle(
    IPC.collection.saveBrunoDirectory,
    createValidatedHandler(
      IPC.collection.saveBrunoDirectory,
      SaveBrunoDirectorySchema,
      ([entries, directoryPath]) => saveBrunoEntriesToDirectory(directoryPath, entries)
    )
  );
}
