import {
  POSTMAN_V3_LIMITS,
  PostmanV3ContainerError,
  type PostmanV3FileMap,
  type PostmanV3Limits,
  resolveLimits,
} from './v3-container';

/**
 * Runtime-neutral walk over a picked Postman v3 folder (#1200). The renderer
 * adapts `<input webkitdirectory>` Files and the CLI adapts `fs` entries to
 * {@link PostmanFolderEntry}; both get the same caps and the same file
 * selection, checked from `size` BEFORE anything is read.
 *
 *  - YAML / JSON files are read;
 *  - other files under a `.resources/` folder (externalised scripts,
 *    binaries) are NOT read but recorded with empty contents, so the
 *    container reader reports them as unread instead of skipping silently;
 *  - everything else is ignored.
 */

export interface PostmanFolderEntry {
  /** Path relative to the picked folder's parent, e.g. `My API/Users/List.request.yaml`. */
  path: string;
  /** Size in bytes, used for the caps before reading. */
  size: number;
  read(): Promise<string>;
}

const READABLE = /\.(ya?ml|json)$/i;

function underResources(path: string): boolean {
  return path.replace(/\\/g, '/').split('/').includes('.resources');
}

export async function collectPostmanFolderFiles(
  entries: readonly PostmanFolderEntry[],
  limits: Partial<PostmanV3Limits> = {}
): Promise<PostmanV3FileMap> {
  const caps = resolveLimits({ ...POSTMAN_V3_LIMITS, ...limits });
  const readable = entries.filter((e) => READABLE.test(e.path));
  const unread = entries.filter((e) => !READABLE.test(e.path) && underResources(e.path));
  if (readable.length + unread.length > caps.maxFiles) {
    throw new PostmanV3ContainerError(`too many files (limit ${caps.maxFiles})`);
  }
  let total = 0;
  for (const e of readable) {
    if (e.size > caps.maxFileBytes) throw new PostmanV3ContainerError(`"${e.path}" is too large`);
    total += e.size;
    if (total > caps.maxTotalBytes) throw new PostmanV3ContainerError('folder is too large');
  }
  const out: PostmanV3FileMap = {};
  for (const e of readable) out[e.path] = await e.read();
  for (const e of unread) out[e.path] = '';
  return out;
}
