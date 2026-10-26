import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { POSTMAN_V3_LIMITS, PostmanV3ContainerError } from '@shared/collections/postman';
import type { PostmanV3Limits } from '@shared/collections/postman/v3-container';
import type { PostmanFolderEntry } from '@shared/collections/postman/v3-folder';

/**
 * Node `fs` adapter for the shared Postman v3 folder walk
 * (`collectPostmanFolderFiles`, #1202). The renderer adapts
 * `<input webkitdirectory>` Files; this adapts a directory argument.
 *
 *  - Paths are relative to the folder's parent (`<folder>/a/b.request.yaml`),
 *    forward-slash separated — the same shape a folder picker produces, so the
 *    shared reader strips the wrapper with `pickedRoot: true`.
 *  - `lstat` only: symlinks (files or directories) are never followed; they
 *    are skipped and returned in `skippedSymlinks` so the caller reports them.
 *  - Directories are streamed (`opendir`) and the walk stops at its cap, so a
 *    huge directory is never listed in full.
 *  - Sizes come from `lstat`, so the shared caps are checked before anything
 *    is read. `read()` re-opens with `O_NOFOLLOW | O_NONBLOCK`, requires a
 *    regular file with the walk's device + inode (a file swapped for a
 *    symlink, FIFO or another file after the walk is refused) and stops at
 *    `maxFileBytes` in case it grew.
 */
export interface PostmanFolderWalk {
  entries: PostmanFolderEntry[];
  skippedSymlinks: string[];
}

export async function walkPostmanFolder(
  dir: string,
  limits: Partial<PostmanV3Limits> = {}
): Promise<PostmanFolderWalk> {
  const caps = { ...POSTMAN_V3_LIMITS, ...limits };
  const entries: PostmanFolderEntry[] = [];
  const skippedSymlinks: string[] = [];
  // Bound the walk itself (not just the files the shared reader keeps), so a
  // huge unrelated tree cannot be enumerated forever.
  const maxVisited = caps.maxFiles * 4;
  let visited = 0;

  const listCapped = async (abs: string): Promise<string[]> => {
    const names: string[] = [];
    const handle = await opendir(abs);
    try {
      for await (const dirent of handle) {
        if (++visited > maxVisited) {
          throw new PostmanV3ContainerError(`too many files (limit ${caps.maxFiles})`);
        }
        names.push(dirent.name);
      }
    } finally {
      // `for await` closes the handle on normal completion; close on throw.
      await handle.close().catch(() => {});
    }
    return names.sort();
  };

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    // `.resources/<Name>.resources/examples` adds a few levels below a folder.
    if (depth > caps.maxDepth + 4) {
      throw new PostmanV3ContainerError(`folder nesting is too deep (limit ${caps.maxDepth})`);
    }
    for (const name of await listCapped(abs)) {
      const childAbs = join(abs, name);
      const childRel = `${rel}/${name}`;
      const info = await lstat(childAbs);
      if (info.isSymbolicLink()) {
        skippedSymlinks.push(childRel);
        continue;
      }
      if (info.isDirectory()) {
        await walk(childAbs, childRel, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      const identity = { dev: info.dev, ino: info.ino };
      entries.push({
        path: childRel,
        size: info.size,
        read: () => readCapped(childAbs, childRel, identity, caps.maxFileBytes),
      });
    }
  };

  await walk(dir, basename(dir), 0);
  return { entries, skippedSymlinks };
}

/** Read at most `max` bytes of the SAME regular file the walk saw. */
async function readCapped(
  path: string,
  rel: string,
  identity: { dev: number; ino: number },
  max: number
): Promise<string> {
  // O_NOFOLLOW: a symlink swapped in after the walk fails to open (ELOOP).
  // O_NONBLOCK: a FIFO swapped in cannot block the open; fstat refuses it.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PostmanV3ContainerError(
      code === 'ELOOP' || code === 'EMLINK'
        ? `"${rel}" became a symlink after the folder was read`
        : `"${rel}" could not be read`
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PostmanV3ContainerError(`"${rel}" is not a regular file`);
    if (info.dev !== identity.dev || info.ino !== identity.ino) {
      throw new PostmanV3ContainerError(`"${rel}" changed after the folder was read`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > max) throw new PostmanV3ContainerError(`"${rel}" is too large`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await handle.close();
  }
}
