import { strFromU8, Unzip, type UnzipFile, UnzipInflate, unzipSync } from 'fflate';
import {
  normaliseEntryPath,
  PostmanV3ContainerError,
  type PostmanV3FileMap,
  type PostmanV3Limits,
  resolveLimits,
} from './v3-container';

/**
 * Unzip a Postman v3 collection archive into the `{ path: text }` map that
 * `readPostmanV3Container` reads (#1200). Kept out of `index.ts` so renderers
 * pay for `fflate` only when a zip is actually imported (dynamic import).
 *
 * Every entry path is checked (absolute / `..` / NUL rejected), the archive
 * itself is size-capped, and entries are inflated as a STREAM with a running
 * byte counter: the sizes a zip declares in its headers are never trusted, so
 * a zip bomb is refused as soon as it inflates past the cap instead of being
 * expanded into memory.
 */
/** Compressed bytes handed to fflate per push (bounds the inflate burst to ~16 MiB). */
const PUSH_SLICE = 16 * 1024;

export function unzipPostmanV3Archive(
  bytes: Uint8Array,
  limits?: Partial<PostmanV3Limits>
): PostmanV3FileMap {
  const caps = resolveLimits(limits);
  if (bytes.byteLength > caps.maxArchiveBytes) {
    throw new PostmanV3ContainerError('archive is too large');
  }
  const out: PostmanV3FileMap = {};
  let count = 0;
  let total = 0;
  let failure: unknown;
  const fail = (error: unknown, file?: UnzipFile) => {
    failure ??= error;
    file?.terminate();
  };
  const unzip = new Unzip((file) => {
    if (failure !== undefined) return;
    let path: string | null;
    try {
      path = normaliseEntryPath(file.name);
    } catch (error) {
      fail(error);
      return;
    }
    if (path === null) return;
    if (++count > caps.maxFiles) {
      fail(new PostmanV3ContainerError(`too many files (limit ${caps.maxFiles})`));
      return;
    }
    const entryPath = path;
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure !== undefined) return;
      if (error) {
        fail(new PostmanV3ContainerError('the file is not a readable zip archive'), file);
        return;
      }
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (size > caps.maxFileBytes || total > caps.maxTotalBytes) {
        fail(new PostmanV3ContainerError(`"${entryPath}" is too large`), file);
        return;
      }
      chunks.push(chunk);
      if (final) out[entryPath] = strFromU8(concat(chunks, size));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // fflate's streaming inflater decompresses everything handed to one push()
    // before calling ondata, so the archive is fed in small slices: each push
    // inflates at most ~PUSH_SLICE * 1032 bytes (DEFLATE's maximum ratio), and
    // the counters stop the feed as soon as a cap trips.
    for (let at = 0; at < bytes.byteLength && failure === undefined; at += PUSH_SLICE) {
      const end = Math.min(at + PUSH_SLICE, bytes.byteLength);
      unzip.push(bytes.subarray(at, end), end === bytes.byteLength);
    }
  } catch (error) {
    fail(
      error instanceof PostmanV3ContainerError
        ? error
        : new PostmanV3ContainerError('the file is not a readable zip archive')
    );
  }
  if (failure !== undefined) throw failure;
  if (count === 0 && !looksLikeZip(bytes)) {
    throw new PostmanV3ContainerError('the file is not a readable zip archive');
  }
  return out;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Local-file or end-of-central-directory signature. */
function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Entry names of a zip, read from its directory without inflating anything. */
export function listZipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter: (file) => {
        names.push(file.name);
        return false;
      },
    });
  } catch {
    throw new PostmanV3ContainerError('the file is not a readable zip archive');
  }
  return names;
}
