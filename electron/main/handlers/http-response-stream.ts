import { pipeline, type Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

/** Decode an Undici response body while enforcing the shared decompressed-size cap. */
export function decodeBodyStream(source: Readable, encoding: string | undefined): Readable {
  const normalizedEncoding = encoding?.trim().toLowerCase();
  const decompressor =
    normalizedEncoding === 'gzip' || normalizedEncoding === 'x-gzip'
      ? createGunzip()
      : normalizedEncoding === 'br'
        ? createBrotliDecompress()
        : normalizedEncoding === 'deflate'
          ? createInflate()
          : undefined;
  if (!decompressor) return source;

  const capped = createSizeCapTransform();
  pipeline(source, decompressor, capped, () => {
    // Errors surface from the returned stream.
  });
  return capped;
}

/** Apply the shared response cap to a body that does not need decompression. */
export function capBodyStream(source: Readable): Readable {
  const capped = createSizeCapTransform();
  pipeline(source, capped, () => {
    // Errors surface from the returned stream.
  });
  return capped;
}

function createSizeCapTransform(): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_RESPONSE_SIZE) {
        callback(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Preserve text bodies when JSON parsing is not applicable. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
