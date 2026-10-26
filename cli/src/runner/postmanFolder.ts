import { lstat, open, readdir } from 'node:fs/promises';
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
 *  - Sizes come from `lstat`, so the shared caps are checked before anything
 *    is read, and `read()` itself stops at `maxFileBytes` in case the file
 *    grew after the walk.
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

  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    // `.resources/<Name>.resources/examples` adds a few levels below a folder.
    if (depth > caps.maxDepth + 4) {
      throw new PostmanV3ContainerError(`folder nesting is too deep (limit ${caps.maxDepth})`);
    }
    const names = (await readdir(abs)).sort();
    for (const name of names) {
      if (++visited > maxVisited) {
        throw new PostmanV3ContainerError(`too many files (limit ${caps.maxFiles})`);
      }
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
      entries.push({
        path: childRel,
        size: info.size,
        read: () => readCapped(childAbs, childRel, caps.maxFileBytes),
      });
    }
  };

  await walk(dir, basename(dir), 0);
  return { entries, skippedSymlinks };
}

/** Read at most `max` bytes; a file that grew past the cap is refused, not truncated. */
async function readCapped(path: string, rel: string, max: number): Promise<string> {
  const handle = await open(path, 'r');
  try {
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
